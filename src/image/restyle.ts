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
export const MAX_COLOUR_CHANGE = 45; // mean change per channel, 0-255, over the product
export const MAX_NEW_SHAPES = 0.08; // share of the old background that may stop being white

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

// Never throws: any failure (API, spend guard, a picture that doesn't match) keeps the plain card.
export async function restyleCard(client: MetaClient, card: Buffer, name: string): Promise<Restyled> {
  try {
    const result = await client.editImage(restyleRequest(card, name));
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) return { card, restyled: false, reason: "no picture returned" };
    const picture = await sharp(Buffer.from(b64, "base64"))
      .flatten({ background: "#ffffff" })
      .resize(CARD_SIZE, CARD_SIZE, { fit: "contain", background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer();
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
