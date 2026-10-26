// Pure mask geometry for the cut-out step. No model calls here.
import type { Box, Mask } from "./sam.ts";

/** Pixels set in both masks. */
export function overlap(a: Mask, b: Mask): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return 0;
  let n = 0;
  for (let y = top; y < bottom; y++) {
    const ra = (y - a.top) * a.width - a.left;
    const rb = (y - b.top) * b.width - b.left;
    for (let x = left; x < right; x++) n += a.bits[ra + x]! & b.bits[rb + x]!;
  }
  return n;
}

/**
 * Greedy dedupe by confidence, as in Meta's SAM 3 Agent (remove_overlapping_masks):
 * keep the most confident mask, drop any later one that shares more than
 * `limit` of the smaller mask's area with a kept one.
 */
export function dedupe<T extends Mask>(masks: readonly T[], limit = 0.3): T[] {
  const kept: T[] = [];
  for (const m of [...masks].sort((a, b) => b.confidence - a.confidence)) {
    if (kept.every((k) => overlap(k, m) <= limit * Math.min(k.area, m.area))) kept.push(m);
  }
  return kept;
}

/** Drops masks that lie mostly on a person (traders, customers, hands). */
export function dropPeople<T extends Mask>(masks: readonly T[], people: readonly Mask[], limit = 0.5): T[] {
  return masks.filter((m) => {
    let onPeople = 0;
    for (const p of people) onPeople += overlap(m, p);
    return onPeople <= limit * m.area;
  });
}

export const boxOf = (m: Mask): Box => ({ left: m.left, top: m.top, right: m.left + m.width, bottom: m.top + m.height });

/** Spark's 0-1000 grid to photo pixels, clamped. Undefined if the box is empty or back to front. */
export function fromGrid(
  g: { x1: number; y1: number; x2: number; y2: number },
  photo: { width: number; height: number },
): Box | undefined {
  const clamp = (v: number) => Math.min(1000, Math.max(0, Number.isFinite(v) ? v : Number.NaN));
  const [x1, y1, x2, y2] = [clamp(g.x1), clamp(g.y1), clamp(g.x2), clamp(g.y2)];
  if ([x1, y1, x2, y2].some(Number.isNaN)) return undefined;
  const box = {
    left: Math.floor((x1 / 1000) * photo.width),
    top: Math.floor((y1 / 1000) * photo.height),
    right: Math.ceil((x2 / 1000) * photo.width),
    bottom: Math.ceil((y2 / 1000) * photo.height),
  };
  if (box.right - box.left < 4 || box.bottom - box.top < 4) return undefined;
  return box;
}

export const toGrid = (b: Box, photo: { width: number; height: number }) => ({
  x1: Math.round((b.left / photo.width) * 1000),
  y1: Math.round((b.top / photo.height) * 1000),
  x2: Math.round((b.right / photo.width) * 1000),
  y2: Math.round((b.bottom / photo.height) * 1000),
});

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const area = (x: Box) => (x.right - x.left) * (x.bottom - x.top);
  return inter / (area(a) + area(b) - inter);
}

const POSITION_OR_LOGIC = new Set([
  "and", "or", "not", "no", "without", "except", "left", "right", "top", "bottom", "middle", "centre", "center",
  "behind", "front", "near", "next", "above", "below", "under", "beside", "corner",
]);

/**
 * A phrase SAM can use: one to four plain words, one concept, no lists,
 * negation or position words (https://dev.meta.ai/docs/sam/segmenting#prompting).
 * Undefined when the phrase can't be made safe.
 */
export function cleanPhrase(raw: string): string | undefined {
  const p = raw.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (p === "" || p.length > 40) return undefined;
  if (!/^[a-z0-9' -]+$/.test(p)) return undefined;
  const words = p.split(" ");
  if (words.length > 4 || words.some((w) => POSITION_OR_LOGIC.has(w))) return undefined;
  return p;
}
