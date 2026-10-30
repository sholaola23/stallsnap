// Turns whatever the trader sent into one upright JPEG that every later step uses,
// so Muse Spark boxes, SAM masks and the cut-outs all share one set of pixel coordinates.
import sharp from "sharp";

export const LONGEST_SIDE = 1600;
const SMALLEST_SIDE = 300;

export class PhotoError extends Error {}

export interface StallPhoto {
  jpeg: Buffer;
  width: number;
  height: number;
}

export async function preparePhoto(input: Buffer): Promise<StallPhoto> {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new PhotoError("That file isn't a photo I can open. Please send the stall picture as a normal photo.");
  }
  if (!meta.width || !meta.height) {
    throw new PhotoError("That file isn't a photo I can open. Please send the stall picture as a normal photo.");
  }
  // .rotate() with no angle applies the EXIF orientation, so width and height are as displayed.
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: LONGEST_SIDE, height: LONGEST_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  if (Math.min(info.width, info.height) < SMALLEST_SIDE) {
    throw new PhotoError("That photo is too small to see the goods. Please send a bigger photo of the stall.");
  }
  return { jpeg: data, width: info.width, height: info.height };
}

export function dataUrl(photo: StallPhoto): string {
  return `data:image/jpeg;base64,${photo.jpeg.toString("base64")}`;
}
