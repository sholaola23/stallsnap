// Messy-input suite: Muse Image results that must not reach a catalogue.
import { beforeAll, expect, test } from "bun:test";
import sharp from "sharp";
import { MAX_BACKGROUND_SPREAD, MAX_PRODUCT_DRIFT, compare } from "../../src/pipeline/cleanup.ts";

const W = 300;
const H = 200;
let cut: Uint8Array;
beforeAll(async () => {
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 20; y < 180; y++) for (let x = 30; x < 180; x++) rgba.set(y % 20 < 10 ? [190, 40, 40, 255] : [240, 220, 60, 255], (y * W + x) * 4);
  cut = new Uint8Array(await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer());
});
const flat = () => sharp(cut).flatten({ background: "#fafafa" });
const passes = (r: { drift: number; spread: number }) => r.drift <= MAX_PRODUCT_DRIFT && r.spread <= MAX_BACKGROUND_SPREAD;

test("refused: product turned greyscale", async () => {
  expect(passes(await compare(cut, new Uint8Array(await flat().greyscale().png().toBuffer())))).toBe(false);
});
test("refused: product recoloured", async () => {
  expect(passes(await compare(cut, new Uint8Array(await flat().tint({ r: 30, g: 120, b: 220 }).png().toBuffer())))).toBe(false);
});
test("refused: product moved", async () => {
  const moved = await sharp(cut).extend({ left: 15, background: { r: 0, g: 0, b: 0, alpha: 0 } }).extract({ left: 0, top: 0, width: W, height: H }).flatten({ background: "#fafafa" }).png().toBuffer();
  expect(passes(await compare(cut, new Uint8Array(moved)))).toBe(false);
});
test("refused: a second product drawn into the background", async () => {
  const extra = await sharp(await flat().png().toBuffer()).composite([{ input: { create: { width: 60, height: 60, channels: 3, background: "#204080" } }, left: 220, top: 120 }]).png().toBuffer();
  expect(passes(await compare(cut, new Uint8Array(extra)))).toBe(false);
});
test("refused: an all-black image", async () => {
  const black = await sharp({ create: { width: W, height: H, channels: 3, background: "#000" } }).png().toBuffer();
  expect(passes(await compare(cut, new Uint8Array(black)))).toBe(false);
});
test("accepted: brighter, a little more contrast, JPEG artefacts, grey background", async () => {
  for (const img of [flat().linear(1, 20), flat().linear(1.15, -10), flat().jpeg({ quality: 60 }), sharp(cut).flatten({ background: "#d8d8d8" })]) {
    expect(passes(await compare(cut, new Uint8Array(await img.toBuffer())))).toBe(true);
  }
});
