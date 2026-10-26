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

export const MAX_INPUT_PIXELS = 100_000_000;

export async function preparePhoto(bytes: Uint8Array): Promise<Photo> {
  // The header gives the size without decoding, so a huge photo gets a reason the trader can act on.
  let size = 0;
  try {
    const m = await sharp(bytes).metadata();
    size = (m.width ?? 0) * (m.height ?? 0);
  } catch {
    // unreadable: the decode below gives the trader message
  }
  if (size > MAX_INPUT_PIXELS) {
    throw new PhotoError("That photo is too large. Please send it as a normal WhatsApp photo, not as a document.");
  }
  let out: { data: Buffer; info: OutputInfo };
  try {
    // failOn "warning": a JPEG with corrupt data is refused, not cut out as garbled pixels.
    out = await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS })
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
