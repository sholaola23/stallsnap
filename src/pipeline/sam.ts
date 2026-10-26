// SAM 3.1 calls (https://dev.meta.ai/docs/sam/segmenting).
//
// One request is one concept phrase, or up to 16 boxes, never both. Requests
// are not streamed; the output is the same segmentation text, read with
// Meta's @meta-sam/parser. Zero matches is a normal result.
import { buildObjectPrompt, decodeMaskToRaster, formats, recordsOfKind } from "@meta-sam/parser";
import type { MetaClient } from "../meta/client.ts";
import { PRICES, SAM_MODEL } from "../meta/costs.ts";
import { jpegDataUrl, outputText } from "../meta/spark.ts";
import type { Photo } from "./photo.ts";

export const MIN_CONFIDENCE = 0.5;
export const MAX_BOXES = 16;

/** A mask in photo pixels: `bits` is row-major, `width * height`, placed at (left, top). */
export type Mask = {
  objectId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  bits: Uint8Array;
  area: number;
  confidence: number;
};

export type Box = { left: number; top: number; right: number; bottom: number }; // right/bottom exclusive

export class SamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamError";
  }
}

/** Reads SAM's segmentation text into masks with confidence at least MIN_CONFIDENCE. */
export function readMasks(text: string, photo: { width: number; height: number }): Mask[] {
  if (text.trim() === "") return [];
  const parser = formats.segmentation.image().createParser();
  parser.push(text);
  const { result } = parser.finish({ status: "completed" });
  const out: Mask[] = [];
  for (const rec of recordsOfKind(result.records, "mask")) {
    const confidence = rec.confidence;
    if (confidence === undefined || !(confidence >= MIN_CONFIDENCE)) continue;
    const { left, top } = rec.bounds;
    const { width, height } = rec.mask;
    if (left < 0 || top < 0 || left + width > photo.width || top + height > photo.height) continue;
    let bits: Uint8Array;
    try {
      bits = decodeMaskToRaster(rec.mask);
    } catch {
      continue;
    }
    let area = 0;
    for (const b of bits) area += b;
    if (area === 0) continue;
    out.push({ objectId: rec.objectId, left, top, width, height, bits, area, confidence });
  }
  return out;
}

async function segment(client: MetaClient, jobId: string, photo: Photo, prompt: string, what: string): Promise<Mask[]> {
  const res = await client.responses(
    { jobId, what, maxUsd: PRICES.samPerImage },
    {
      model: SAM_MODEL,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: jpegDataUrl(photo.jpeg) },
          ],
        },
      ],
      metadata: { include_confidence: "true", mask_encoding: "one_bit" },
    },
    () => PRICES.samPerImage,
  );
  const status = (res as { status?: unknown }).status;
  if (status !== undefined && status !== "completed") throw new SamError(`${what}: response ${String(status)}`);
  return readMasks(outputText(res) ?? "", photo);
}

/** Every instance of one short concept, such as "tomato tin". */
export function segmentPhrase(client: MetaClient, jobId: string, photo: Photo, phrase: string): Promise<Mask[]> {
  return segment(client, jobId, photo, phrase, `sam "${phrase}"`);
}

/** One mask per box, each reported under its box's index as objectId. */
export function segmentBoxes(client: MetaClient, jobId: string, photo: Photo, boxes: readonly Box[]): Promise<Mask[]> {
  if (boxes.length === 0) return Promise.resolve([]);
  if (boxes.length > MAX_BOXES) throw new SamError(`At most ${MAX_BOXES} boxes per request`);
  const prompt = buildObjectPrompt({
    size: { width: photo.width, height: photo.height },
    objects: boxes.map((box, i) => ({ id: i, prompts: [{ box }] })),
  });
  return segment(client, jobId, photo, prompt, `sam ${boxes.length} boxes`);
}
