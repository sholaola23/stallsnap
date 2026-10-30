// Step 3 of the photo: cut each product out of the real photo with its SAM mask.
// Nothing here draws or invents a product: every pixel kept comes from the trader's photo.
import sharp from "sharp";
import type { FoundProduct } from "./find.ts";
import type { StallPhoto } from "./photo.ts";
import type { ProductMask } from "./segment.ts";

// A mask filling under this share of its box is probably a miss (an edge, a shadow, a sliver).
export const MIN_COVERAGE = 0.12;
const CARD_SIZE = 600;

export interface Cutout {
  productId: number;
  name: string;
  png: Buffer; // product on a transparent background
  card: Buffer; // product centred on a plain white square, ready for the catalogue
}

export async function cutOut(photo: StallPhoto, product: FoundProduct, mask: ProductMask): Promise<Cutout> {
  const { left, top } = mask.bounds;
  const width = mask.bounds.right - left;
  const height = mask.bounds.bottom - top;
  const rgb = await sharp(photo.jpeg).extract({ left, top, width, height }).removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[i * 3]!;
    rgba[i * 4 + 1] = rgb[i * 3 + 1]!;
    rgba[i * 4 + 2] = rgb[i * 3 + 2]!;
    rgba[i * 4 + 3] = mask.raster[i] ? 255 : 0;
  }
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).trim({ threshold: 0 }).png().toBuffer();
  const card = await sharp(png)
    .resize({ width: CARD_SIZE * 0.8, height: CARD_SIZE * 0.8, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const cardMeta = await sharp(card).metadata();
  const square = await sharp({
    create: { width: CARD_SIZE, height: CARD_SIZE, channels: 3, background: "#ffffff" },
  })
    .composite([
      {
        input: card,
        left: Math.round((CARD_SIZE - (cardMeta.width ?? 0)) / 2),
        top: Math.round((CARD_SIZE - (cardMeta.height ?? 0)) / 2),
      },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
  return { productId: product.id, name: product.name, png, card: square };
}

const TINTS: readonly [number, number, number][] = [
  [230, 25, 75],
  [60, 180, 75],
  [0, 130, 200],
  [245, 130, 48],
  [145, 30, 180],
  [70, 240, 240],
  [240, 50, 230],
  [210, 245, 60],
];

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// The stall photo with every mask tinted and numbered: shows what SAM found, for review and the demo.
export async function overlay(photo: StallPhoto, products: readonly FoundProduct[], masks: readonly ProductMask[]): Promise<Buffer> {
  const { width, height } = photo;
  const rgb = await sharp(photo.jpeg).removeAlpha().raw().toBuffer();
  for (const [index, mask] of masks.entries()) {
    const [r, g, b] = TINTS[index % TINTS.length]!;
    const mw = mask.bounds.right - mask.bounds.left;
    for (let y = mask.bounds.top; y < mask.bounds.bottom; y++) {
      for (let x = mask.bounds.left; x < mask.bounds.right; x++) {
        if (!mask.raster[(y - mask.bounds.top) * mw + (x - mask.bounds.left)]) continue;
        const p = (y * width + x) * 3;
        rgb[p] = (rgb[p]! + r) >> 1;
        rgb[p + 1] = (rgb[p + 1]! + g) >> 1;
        rgb[p + 2] = (rgb[p + 2]! + b) >> 1;
      }
    }
  }
  const labels = products
    .map((p) => {
      const x = p.box.left + 4;
      const y = Math.max(p.box.top + 22, 22);
      return `<text x="${x}" y="${y}" font-family="sans-serif" font-size="20" font-weight="bold" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${p.id}. ${escapeXml(p.name)}</text>`;
    })
    .join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`);
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .composite([{ input: svg }])
    .jpeg({ quality: 85 })
    .toBuffer();
}
