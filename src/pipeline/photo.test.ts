import { expect, test } from "bun:test";
import sharp from "sharp";
import { MAX_SIDE, PhotoError, preparePhoto } from "./photo.ts";

const jpeg = (width: number, height: number, orientation?: number) => {
  let s = sharp({ create: { width, height, channels: 3, background: "#cc8844" } }).jpeg();
  if (orientation) s = s.withMetadata({ orientation });
  return s.toBuffer().then((b) => new Uint8Array(b));
};

test("a phone photo sideways in EXIF is turned upright, so SAM sees what the trader sees", async () => {
  const p = await preparePhoto(await jpeg(800, 600, 6)); // 6 = rotate 90 degrees
  expect([p.width, p.height]).toEqual([600, 800]);
});

test("a big photo is shrunk to MAX_SIDE on its longest side", async () => {
  const p = await preparePhoto(await jpeg(4000, 3000));
  expect([p.width, p.height]).toEqual([MAX_SIDE, 1200]);
  const meta = await sharp(p.jpeg).metadata();
  expect(meta.format).toBe("jpeg");
});

test("a small photo is not enlarged, and a tiny one is refused", async () => {
  expect((await preparePhoto(await jpeg(640, 480))).width).toBe(640);
  await expect(preparePhoto(await jpeg(150, 100))).rejects.toBeInstanceOf(PhotoError);
});

test("a PNG with transparency is flattened onto white", async () => {
  const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const p = await preparePhoto(new Uint8Array(png));
  const { data } = await sharp(p.jpeg).raw().toBuffer({ resolveWithObject: true });
  expect(data[0]!).toBeGreaterThan(240);
});
