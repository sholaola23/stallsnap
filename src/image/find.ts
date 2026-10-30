// Step 1 of the photo: Muse Spark looks at the stall and lists each product line with a box
// around one clear example. Grounding guide: https://dev.meta.ai/docs/image-understanding#perception-grounding
import { MetaClient, outputText } from "../meta/client.ts";
import { dataUrl, type StallPhoto } from "./photo.ts";

export const SPARK_MODEL = "muse-spark-1.3";
// A busy stall (a wall of sandals) can hold 60+ designs; 64 is four SAM requests.
export const MAX_PRODUCTS = 64;

export interface PixelBox {
  left: number;
  top: number;
  right: number; // exclusive
  bottom: number; // exclusive
}

export interface FoundProduct {
  id: number;
  name: string;
  box: PixelBox;
}

const PROMPT = `You are an object grounding expert looking at a photo of a market stall.
List every distinct product line the trader is selling. Count a product once even if many of the same item are on show: identical items in the same size are one product line.
For each product line, give a short plain name a shopper would use (for example "Peak milk tin", "red ankara fabric", "iPhone charger") and a bounding box around the single clearest, least covered example of it.
Do not miss any product. Leave out people, tables, baskets, bowls, shelves, signs and price cards unless they are clearly for sale.
Coordinates are on a 0-1000 grid with (0,0) at the top left of the image.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["products"],
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "x_min", "y_min", "x_max", "y_max"],
        properties: {
          name: { type: "string" },
          x_min: { type: "integer" },
          y_min: { type: "integer" },
          x_max: { type: "integer" },
          y_max: { type: "integer" },
        },
      },
    },
  },
};

export function findRequest(photo: StallPhoto): Record<string, unknown> {
  return {
    model: SPARK_MODEL,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: PROMPT },
          { type: "input_image", image_url: dataUrl(photo) },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: "stall_products", schema: SCHEMA, strict: true } },
  };
}

interface RawProduct {
  name?: unknown;
  x_min?: unknown;
  y_min?: unknown;
  x_max?: unknown;
  y_max?: unknown;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

// Converts Spark's 0-1000 boxes to pixels and drops anything unusable. Exported for tests.
export function toProducts(raw: unknown, width: number, height: number): FoundProduct[] {
  const list = (raw as { products?: unknown })?.products;
  if (!Array.isArray(list)) return [];
  const products: FoundProduct[] = [];
  const seen = new Set<string>();
  for (const item of list as RawProduct[]) {
    const name = typeof item.name === "string" ? item.name.trim().replace(/\s+/g, " ") : "";
    const coords = [item.x_min, item.y_min, item.x_max, item.y_max];
    if (!name || !coords.every((c) => typeof c === "number" && Number.isFinite(c))) continue;
    const [x1, y1, x2, y2] = coords as number[];
    const box: PixelBox = {
      left: Math.floor((clamp(Math.min(x1!, x2!), 1000) * width) / 1000),
      top: Math.floor((clamp(Math.min(y1!, y2!), 1000) * height) / 1000),
      right: Math.ceil((clamp(Math.max(x1!, x2!), 1000) * width) / 1000),
      bottom: Math.ceil((clamp(Math.max(y1!, y2!), 1000) * height) / 1000),
    };
    // Boxes under 8 pixels a side can't make a usable catalogue picture.
    if (box.right - box.left < 8 || box.bottom - box.top < 8) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({ id: products.length + 1, name, box });
    if (products.length === MAX_PRODUCTS) break;
  }
  return products;
}

export async function findProducts(client: MetaClient, photo: StallPhoto): Promise<FoundProduct[]> {
  const events = await client.respond(findRequest(photo));
  const text = outputText(events);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Muse Spark did not return JSON for the product list: ${text.slice(0, 200)}`);
  }
  return toProducts(parsed, photo.width, photo.height);
}
