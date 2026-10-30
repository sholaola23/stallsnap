// Step 2 of the photo: SAM 3.1 turns each Muse Spark box into a pixel mask.
// Box prompts, up to 16 objects a request: https://dev.meta.ai/docs/sam/segmenting#object-prompts
import {
  buildObjectPrompt,
  decodeMaskToRaster,
  parseImageStream,
  recordsOfKind,
  type SegmentationMaskBounds,
} from "@meta-sam/parser";
import { MetaClient, type StreamEvent } from "../meta/client.ts";
import type { FoundProduct } from "./find.ts";
import { dataUrl, type StallPhoto } from "./photo.ts";

export const SAM_MODEL = "sam-3.1";
export const OBJECTS_PER_REQUEST = 16;

export interface ProductMask {
  productId: number;
  bounds: SegmentationMaskBounds; // where the raster sits in the photo
  raster: Uint8Array; // row-major 0/1, (right-left) x (bottom-top)
  coverage: number; // share of the box the mask fills, 0 to 1
}

export function segmentRequest(photo: StallPhoto, products: readonly FoundProduct[]): Record<string, unknown> {
  const text = buildObjectPrompt({
    size: { width: photo.width, height: photo.height },
    objects: products.map((p) => ({ id: p.id, prompts: [{ box: p.box }] })),
  });
  return {
    model: SAM_MODEL,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text },
          { type: "input_image", image_url: dataUrl(photo) },
        ],
      },
    ],
    metadata: { mask_encoding: "one_bit" },
  };
}

async function* replay(events: readonly StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event;
}

// Resizes a raster with nearest neighbour, in case SAM's mask size differs from its box.
function fitRaster(raster: Uint8Array, fromW: number, fromH: number, toW: number, toH: number): Uint8Array {
  if (fromW === toW && fromH === toH) return raster;
  const out = new Uint8Array(toW * toH);
  for (let y = 0; y < toH; y++) {
    const sy = Math.min(fromH - 1, Math.floor((y * fromH) / toH));
    for (let x = 0; x < toW; x++) {
      const sx = Math.min(fromW - 1, Math.floor((x * fromW) / toW));
      out[y * toW + x] = raster[sy * fromW + sx]!;
    }
  }
  return out;
}

export async function masksFromEvents(events: readonly StreamEvent[]): Promise<ProductMask[]> {
  const result = await parseImageStream(replay(events)).finalResult;
  const masks: ProductMask[] = [];
  for (const record of recordsOfKind(result.records, "mask")) {
    const productId = Number(record.objectId);
    const { bounds, mask } = record;
    const w = bounds.right - bounds.left;
    const h = bounds.bottom - bounds.top;
    const raster = fitRaster(decodeMaskToRaster(mask), mask.width, mask.height, w, h);
    let filled = 0;
    for (const v of raster) filled += v;
    masks.push({ productId, bounds, raster, coverage: w * h > 0 ? filled / (w * h) : 0 });
  }
  return masks;
}

export async function segmentProducts(
  client: MetaClient,
  photo: StallPhoto,
  products: readonly FoundProduct[],
): Promise<ProductMask[]> {
  const masks: ProductMask[] = [];
  for (let i = 0; i < products.length; i += OBJECTS_PER_REQUEST) {
    const batch = products.slice(i, i + OBJECTS_PER_REQUEST);
    const events = await client.respond(segmentRequest(photo, batch));
    masks.push(...(await masksFromEvents(events)));
  }
  return masks;
}
