// Step 4 of the photo (optional): Muse Image tidies a real cut-out for the catalogue: plain white
// background, even light. It may only restyle the trader's own product, so our code compares the
// result with the cut-out it was given and keeps the plain cut-out whenever they differ too much.
// Guide: https://dev.meta.ai/docs/image-generation#edit
import sharp from "sharp";
import type { MetaClient } from "../meta/client.ts";

export const IMAGE_MODEL = "muse-image-1.0";
const CARD_SIZE = 600;
const GRID = 48; // pictures are compared on a 48 x 48 grid
const WHITE = 235; // a grid cell with every channel above this counts as background
export const MAX_COLOUR_CHANGE = 15; // mean change per channel, 0-255, over the product
export const MAX_NEW_SHAPES = 0.08; // share of the old background that may stop being white
export const MAX_OUTLINE_CHANGE = 1.2; // the product's width-to-height ratio may change by at most this factor
const INK = 225; // a pixel with any channel below this is part of the product when finding its outline

export function restyleRequest(card: Buffer, name: string): Record<string, unknown> {
  return {
    model: IMAGE_MODEL,
    prompt:
      `Product photo clean-up for a market trader's price list. The product is: ${name}. ` +
      "Keep this exact product unchanged: the same shape, colours, labels, text, pattern and number of items. " +
      "Only make the background plain white, even out the lighting and soften harsh shadows. " +
      "Do not add, remove, replace or redraw any object, and do not add text.",
    images: [{ image_url: `data:image/jpeg;base64,${card.toString("base64")}` }],
    n: 1,
    output_format: "jpeg",
    reasoning_strength: "low",
    // No look-ups: a search could swap the trader's item for a stock picture of a similar one.
    tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
  };
}

async function grid(picture: Buffer): Promise<Buffer> {
  return sharp(picture).flatten({ background: "#ffffff" }).resize(GRID, GRID, { fit: "fill" }).removeAlpha().raw().toBuffer();
}

export interface Likeness {
  colourChange: number; // mean change per channel over the product's cells
  newShapes: number; // share of the old background cells that are no longer white
}

// How far the restyled picture moved from the cut-out. Exported for tests and the CLI.
export async function likeness(original: Buffer, restyled: Buffer): Promise<Likeness> {
  const [a, b] = await Promise.all([grid(original), grid(restyled)]);
  let productCells = 0;
  let change = 0;
  let backgroundCells = 0;
  let filled = 0;
  for (let i = 0; i < GRID * GRID; i++) {
    const [r, g, bl] = [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
    const background = r > WHITE && g > WHITE && bl > WHITE;
    if (background) {
      backgroundCells += 1;
      if (Math.min(b[i * 3]!, b[i * 3 + 1]!, b[i * 3 + 2]!) <= WHITE) filled += 1;
    } else {
      productCells += 1;
      change += (Math.abs(r - b[i * 3]!) + Math.abs(g - b[i * 3 + 1]!) + Math.abs(bl - b[i * 3 + 2]!)) / 3;
    }
  }
  return { colourChange: productCells ? change / productCells : 255, newShapes: backgroundCells ? filled / backgroundCells : 0 };
}

export interface Restyled {
  card: Buffer; // the restyled card, or the plain cut-out card when it was refused
  restyled: boolean;
  reason: string;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The product's outline on a white card: rows and columns with at least 3 product pixels, so faint
// specks and the light ghost pattern Muse Image leaves on its backgrounds don't count.
async function productBox(picture: Buffer): Promise<Box | null> {
  const { data, info } = await sharp(picture).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = new Array<number>(info.height).fill(0);
  const cols = new Array<number>(info.width).fill(0);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      if (Math.min(data[i]!, data[i + 1]!, data[i + 2]!) < INK) {
        rows[y]! += 1;
        cols[x]! += 1;
      }
    }
  }
  const span = (counts: number[]) => {
    const first = counts.findIndex((c) => c >= 3);
    return [first, counts.length - 1 - [...counts].reverse().findIndex((c) => c >= 3)] as const;
  };
  const [top, bottom] = span(rows);
  const [left, right] = span(cols);
  if (top < 0 || left < 0) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

// Muse Image often zooms in on the product. Put its product back where, and as big as, the cut-out
// had it, on pure white, so the comparison lines up pixel for pixel and the page keeps the trader's framing.
async function alignTo(box: Box, picture: Buffer, pictureBox: Box): Promise<Buffer> {
  const product = await sharp(picture)
    .extract(pictureBox)
    .resize(box.width, box.height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data } = product;
  for (let i = 0; i < data.length; i += 3) {
    if (data[i]! > WHITE && data[i + 1]! > WHITE && data[i + 2]! > WHITE) data.fill(255, i, i + 3);
  }
  const raw = { width: product.info.width, height: product.info.height, channels: 3 as const };
  return sharp({ create: { width: CARD_SIZE, height: CARD_SIZE, channels: 3, background: "#ffffff" } })
    .composite([{ input: data, raw, left: box.left, top: box.top }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

// Never throws: any failure (API, spend guard, a picture that doesn't match) keeps the plain card.
export async function restyleCard(client: MetaClient, card: Buffer, name: string): Promise<Restyled> {
  try {
    const result = await client.editImage(restyleRequest(card, name));
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) return { card, restyled: false, reason: "no picture returned" };
    const returned = await sharp(Buffer.from(b64, "base64"))
      .flatten({ background: "#ffffff" })
      .resize(CARD_SIZE, CARD_SIZE, { fit: "contain", background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer();
    const [box, returnedBox] = await Promise.all([productBox(card), productBox(returned)]);
    if (!box || !returnedBox) return { card, restyled: false, reason: "no product found in the picture" };
    // A stack of two sachets coming back as two stacks, or a cut-off item "completed", changes the outline.
    const outline = returnedBox.width / returnedBox.height / (box.width / box.height);
    if (Math.max(outline, 1 / outline) > MAX_OUTLINE_CHANGE) {
      return { card, restyled: false, reason: `the product's outline changed (${Math.max(outline, 1 / outline).toFixed(2)} > ${MAX_OUTLINE_CHANGE})` };
    }
    const picture = await alignTo(box, returned, returnedBox);
    const like = await likeness(card, picture);
    if (like.colourChange > MAX_COLOUR_CHANGE) {
      return { card, restyled: false, reason: `product changed too much (${like.colourChange.toFixed(0)} > ${MAX_COLOUR_CHANGE})` };
    }
    if (like.newShapes > MAX_NEW_SHAPES) {
      return { card, restyled: false, reason: `something was added (${(like.newShapes * 100).toFixed(0)}% of the background)` };
    }
    return { card: picture, restyled: true, reason: `kept (change ${like.colourChange.toFixed(0)}, added ${(like.newShapes * 100).toFixed(0)}%)` };
  } catch (error) {
    return { card, restyled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
