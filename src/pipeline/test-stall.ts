// Test fixtures for the cut-out step: a drawn stall photo and SAM responses
// built with @meta-sam/parser's own encoder (its internal encoder for
// synthetic conformance data, imported by path because it isn't exported).
import sharp from "sharp";
import { encodeSegmentationMask } from "../../node_modules/@meta-sam/parser/dist/mask-codec.js";
import type { Box } from "./sam.ts";
import type { Photo } from "./photo.ts";

export const W = 400;
export const H = 300;

// Boxes on the drawn stall (right/bottom exclusive).
export const TOMATO: Box = { left: 20, top: 40, right: 100, bottom: 120 };
export const MILK: Box = { left: 150, top: 40, right: 230, bottom: 120 };
export const RICE: Box = { left: 280, top: 160, right: 380, bottom: 280 };
export const PERSON: Box = { left: 0, top: 150, right: 120, bottom: 300 };
export const BAG_ON_PERSON: Box = { left: 20, top: 180, right: 80, bottom: 260 };

export async function stallPhoto(): Promise<Photo> {
  const rect = (b: Box, color: string) => ({
    input: { create: { width: b.right - b.left, height: b.bottom - b.top, channels: 3 as const, background: color } },
    left: b.left,
    top: b.top,
  });
  const jpeg = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite([rect(PERSON, "#333333"), rect(TOMATO, "#ff0000"), rect(MILK, "#0000ff"), rect(RICE, "#00aa00"), rect(BAG_ON_PERSON, "#888800")])
    .jpeg({ quality: 95 })
    .toBuffer();
  return { jpeg: new Uint8Array(jpeg), width: W, height: H };
}

/** SAM output text for full-box masks with the given confidence. */
export function samText(records: { box: Box; c: number; id?: number }[]): string {
  if (records.length === 0) return "";
  const parts = records.map((r, i) => {
    const w = r.box.right - r.box.left;
    const h = r.box.bottom - r.box.top;
    const m = encodeSegmentationMask(new Uint8Array(w * h).fill(1), w, h) as { payload: string };
    return `${r.id ?? i}<|box;x1=${r.box.left};y1=${r.box.top};x2=${r.box.right - 1};y2=${r.box.bottom - 1};w=${W};h=${H};c=${r.c}|><|mask;x=0;y=0;c=${r.c};data=${h},${w},${m.payload}|>`;
  });
  return `<0f>${parts.join(",")}`;
}

export const responseWithText = (text: string, extra: Record<string, unknown> = {}) => ({
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 } },
  ...extra,
});

/** Reads what a fake Meta call asked for. */
export function describeCall(body: unknown): { model: string; prompt: string; format: string | undefined; texts: string[] } {
  const b = body as { model: string; input: { role: string; content: { type: string; text?: string }[] }[]; text?: { format?: { name?: string } } };
  const user = b.input.find((m) => m.role === "user");
  const texts = (user?.content ?? []).filter((p) => p.type === "input_text").map((p) => p.text ?? "");
  return { model: b.model, prompt: texts[0] ?? "", format: b.text?.format?.name, texts };
}
