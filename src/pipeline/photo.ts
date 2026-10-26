// Prepares a trader's stall photo: applies the EXIF rotation, so SAM's
// coordinates match what the trader sees, and shrinks it to at most
// MAX_SIDE pixels on its longest side.
import sharp, { type OutputInfo } from "sharp";

export const MAX_SIDE = 1600;
export const MIN_SIDE = 200;

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

export type Photo = { jpeg: Uint8Array; width: number; height: number };

export async function preparePhoto(bytes: Uint8Array): Promise<Photo> {
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new PhotoError("That photo couldn't be opened. Please send it again as a normal photo.");
  }
  const { width, height } = out.info;
  if (Math.min(width, height) < MIN_SIDE) {
    throw new PhotoError("That photo is too small to see the products. Please send a bigger photo of your stall.");
  }
  return { jpeg: new Uint8Array(out.data), width, height };
}
