// Muse Image clean-up of one real product cut-out: a plain light background
// and even lighting, nothing else.
//
// Muse Image has no setting that keeps pixels unchanged (mask, input_fidelity
// and seed are rejected, https://dev.meta.ai/docs/image-generation), and Meta
// warns it may "clean up" real wear. So the prompt names what must stay, and
// the result is checked against the trader's own cut-out before it is used:
// - inside the product, colours must stay close to the original;
// - outside it, the background must stay plain, so nothing was added.
// If either check fails, or the call fails or is refused, the plain cut-out
// is used. Muse Image never makes a product the trader doesn't sell.
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import type { JobLog } from "../joblog.ts";
import type { MetaClient } from "../meta/client.ts";
import { IMAGE_MODEL, PRICES } from "../meta/costs.ts";

export const MAX_PRODUCT_DRIFT = 28; // mean absolute difference per channel, 0 to 255
export const MAX_BACKGROUND_SPREAD = 18; // standard deviation of background brightness
const CHECK_SIDE = 96;
const INPUT_BACKDROP = { r: 236, g: 236, b: 236 };

export const CLEANUP_PROMPT = [
  "Clean up this product photo for a market trader's catalogue.",
  "Keep the product exactly as it is: the same shape, size, position, colours, label text, logos and packaging, including any wear, dents or marks.",
  "Do not add, remove, replace or redraw anything on the product.",
  "Only change the background to a plain soft white studio background and even out the lighting.",
  "No props, no text, no other objects, no people.",
].join(" ");

export type CleanupResult =
  | { png: Uint8Array; cleaned: true; drift: number; spread: number }
  | { png: Uint8Array; cleaned: false; reason: string; drift?: number; spread?: number };

type Raster = { data: Buffer; width: number; height: number };

async function rgbaAt(image: Uint8Array, width: number, height: number): Promise<Raster> {
  const data = await sharp(image).resize({ width, height, fit: "fill" }).ensureAlpha().raw().toBuffer();
  return { data, width, height };
}

/** Compares a cleaned image with the cut-out it came from. */
export async function compare(cutout: Uint8Array, cleaned: Uint8Array): Promise<{ drift: number; spread: number }> {
  const meta = await sharp(cutout).metadata();
  const scale = CHECK_SIDE / Math.max(meta.width!, meta.height!);
  const w = Math.max(8, Math.round(meta.width! * scale));
  const h = Math.max(8, Math.round(meta.height! * scale));
  const a = await rgbaAt(cutout, w, h);
  const b = await rgbaAt(cleaned, w, h);

  let diff = 0;
  let inside = 0;
  const outside: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (a.data[i + 3]! > 200) {
        diff += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
        inside++;
      } else if (a.data[i + 3]! < 10 && clearOfProduct(a, x, y, 2)) {
        // Skip a thin ring round the product, where a soft shadow is fine.
        outside.push(0.299 * b.data[i]! + 0.587 * b.data[i + 1]! + 0.114 * b.data[i + 2]!);
      }
    }
  }
  const drift = inside === 0 ? Number.POSITIVE_INFINITY : diff / (inside * 3);
  const mean = outside.reduce((s, v) => s + v, 0) / Math.max(1, outside.length);
  const spread = Math.sqrt(outside.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, outside.length));
  return { drift, spread };
}

function clearOfProduct(r: Raster, x: number, y: number, ring: number): boolean {
  for (let dy = -ring; dy <= ring; dy++) {
    for (let dx = -ring; dx <= ring; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= r.width || yy >= r.height) continue;
      if (r.data[(yy * r.width + xx) * 4 + 3]! > 10) return false;
    }
  }
  return true;
}

export async function cleanUp(client: MetaClient, jobId: string, cutout: Uint8Array): Promise<CleanupResult> {
  const plain = (reason: string, extra: { drift?: number; spread?: number } = {}): CleanupResult => ({ png: cutout, cleaned: false, reason, ...extra });
  let width: number;
  let height: number;
  try {
    const meta = await sharp(cutout).metadata();
    width = meta.width!;
    height = meta.height!;
  } catch {
    return plain("cut-out unreadable");
  }
  if (Math.min(width, height) < 48) return plain("cut-out too small to clean");
  if (Math.max(width, height) / Math.min(width, height) > 16) return plain("cut-out too narrow to clean");

  try {
    const input = await sharp(cutout).flatten({ background: INPUT_BACKDROP }).png().toBuffer();
    const res = (await client.imagesEdit(
      { jobId, what: "muse image clean-up", maxUsd: PRICES.imagePerImage },
      {
        model: IMAGE_MODEL,
        prompt: CLEANUP_PROMPT,
        images: [{ image_url: `data:image/png;base64,${input.toString("base64")}` }],
        n: 1,
        size: `${width}x${height}`,
        output_format: "png",
        reasoning_strength: "low",
        tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
      },
      (r) => (Array.isArray((r as { data?: unknown }).data) && (r as { data: unknown[] }).data.length > 0 ? PRICES.imagePerImage : 0),
    )) as { data?: { b64_json?: unknown }[] };

    const b64 = res.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64 === "") return plain("no image returned");
    const out = new Uint8Array(Buffer.from(b64, "base64"));
    const outMeta = await sharp(out).metadata();
    const ratioIn = width / height;
    const ratioOut = outMeta.width! / outMeta.height!;
    if (Math.abs(ratioIn - ratioOut) / ratioIn > 0.05) return plain("returned image has a different shape");

    const { drift, spread } = await compare(cutout, out);
    if (!(drift <= MAX_PRODUCT_DRIFT)) return plain("product changed too much", { drift, spread });
    if (!(spread <= MAX_BACKGROUND_SPREAD)) return plain("background not plain", { drift, spread });
    const png = await sharp(out).resize({ width, height, fit: "fill" }).png().toBuffer();
    return { png: new Uint8Array(png), cleaned: true, drift, spread };
  } catch (e) {
    return plain(`clean-up failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }
}

/**
 * The publish-time clean-up for one job's items. Each item is one job step, so
 * a republish after a restart doesn't pay twice. Any failure, including a step
 * a crash cut off, gives the plain cut-out: clean-up never stops a catalogue.
 */
export function cleanupStep(log: JobLog, client: MetaClient, jobId: string, onPlain: (item: number, reason: string) => void = () => {}) {
  return async (item: { item: number; file: string }, png: Uint8Array): Promise<Uint8Array> => {
    try {
      const file = await log.step(jobId, `cleanup:item-${item.item}`, async () => {
        const result = await cleanUp(client, jobId, png);
        if (!result.cleaned) {
          onPlain(item.item, result.reason);
          return item.file;
        }
        const cleaned = item.file.replace(/\.png$/, "") + ".clean.png";
        writeFileSync(cleaned, result.png);
        return cleaned;
      });
      return new Uint8Array(readFileSync(file));
    } catch (e) {
      onPlain(item.item, e instanceof Error ? e.message : String(e));
      return png;
    }
  };
}
