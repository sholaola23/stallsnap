import { describe, expect, test } from "bun:test";
import { cleanPhrase, dedupe, dropPeople, fromGrid, iou, overlap, toGrid } from "./masks.ts";
import type { Mask } from "./sam.ts";

const rect = (left: number, top: number, width: number, height: number, confidence = 0.9): Mask => ({
  objectId: `${left},${top}`,
  left,
  top,
  width,
  height,
  bits: new Uint8Array(width * height).fill(1),
  area: width * height,
  confidence,
});

test("overlap counts shared pixels", () => {
  expect(overlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(25);
  expect(overlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(0);
});

describe("dedupe", () => {
  test("keeps the more confident of two masks sharing over 30% of the smaller", () => {
    const kept = dedupe([rect(0, 0, 10, 10, 0.6), rect(2, 0, 10, 10, 0.9)]);
    expect(kept.map((m) => m.confidence)).toEqual([0.9]);
  });
  test("keeps both when they share 30% or less", () => {
    expect(dedupe([rect(0, 0, 10, 10), rect(7, 0, 10, 10)])).toHaveLength(2);
  });
  test("a small mask inside a big one is a duplicate, whichever is more confident", () => {
    expect(dedupe([rect(0, 0, 100, 100, 0.9), rect(10, 10, 5, 5, 0.95)])).toHaveLength(1);
  });
});

test("dropPeople drops masks mostly on a person", () => {
  const person = rect(0, 0, 50, 100);
  const kept = dropPeople([rect(10, 10, 20, 20), rect(40, 10, 20, 20), rect(100, 0, 10, 10)], [person]);
  expect(kept.map((m) => m.left)).toEqual([40, 100]);
});

describe("grid boxes", () => {
  const photo = { width: 400, height: 300 };
  test("0-1000 grid to pixels", () => {
    expect(fromGrid({ x1: 500, y1: 0, x2: 1000, y2: 500 }, photo)).toEqual({ left: 200, top: 0, right: 400, bottom: 150 });
  });
  test("round trip stays close", () => {
    const b = { left: 21, top: 40, right: 99, bottom: 120 };
    const back = fromGrid(toGrid(b, photo), photo)!;
    expect(Math.abs(back.left - b.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.bottom - b.bottom)).toBeLessThanOrEqual(1);
  });
  test("iou", () => {
    expect(iou({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 0, right: 15, bottom: 10 })).toBeCloseTo(50 / 150);
  });
});

test("cleanPhrase keeps plain short noun phrases", () => {
  expect(cleanPhrase("  Tomato   Tin. ")).toBe("tomato tin");
  expect(cleanPhrase("Peak milk 400g")).toBe("peak milk 400g");
});
