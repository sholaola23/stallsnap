// Stall photo to one cut-out per product, following Meta's SAM 3 Agent pattern:
//
// 1. Muse Spark looks at the photo and proposes each product with two short
//    phrasings, plus one broad phrase for the stall's goods.
// 2. SAM 3.1 segments every phrasing, and "person" once.
// 3. Masks lying mostly on a person are dropped; overlapping masks are
//    deduped greedily by confidence.
// 4. Muse Spark reviews a zoomed crop of each mask: is it one sellable
//    product? Rejected crops are dropped.
// 5. Muse Spark marks boxes round products nothing caught; SAM segments those
//    boxes in one request.
// 6. Each kept mask becomes a transparent PNG cut from the trader's own
//    pixels. Nothing is generated.
import sharp from "sharp";
import type { MetaClient } from "../meta/client.ts";
import { jpegDataUrl, sparkJson, type UserPart } from "../meta/spark.ts";
import { boxOf, cleanPhrase, dedupe, dropPeople, fromGrid, iou, overlap, toGrid } from "./masks.ts";
import type { Photo } from "./photo.ts";
import { MAX_BOXES, segmentBoxes, segmentPhrase, type Mask } from "./sam.ts";

export const MAX_PRODUCTS = 12;
/** Extra cut-outs from the broad phrase, beyond the proposed products. */
export const MAX_BROAD_EXTRAS = 6;
/** A mask covering more than this share of the photo is a table or the whole stall, not a product. */
export const MAX_MASK_SHARE = 0.4;
const REVIEW_BATCH = 8;
const SAM_PARALLEL = 4;

export type Cutout = {
  name: string;
  mask: Mask;
  /** "phrase": found by a concept phrase and approved on review; "box": found from a box Spark drew. */
  source: "phrase" | "box";
};

type Proposal = { name: string; phrases: string[] };
/** A mask with the name it would get. `product` is the proposal it came from; broad-phrase and box masks have none. */
type Candidate = Mask & { name: string; product?: number };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** Model output is untrusted: anything that isn't an object reads as an empty one. */
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function proposeProducts(client: MetaClient, jobId: string, photo: Photo): Promise<{ products: Proposal[]; broad: string | undefined }> {
  const out = (await sparkJson(client, {
    jobId,
    what: "spark propose products",
    name: "stall_products",
    maxOutputTokens: 8000,
    developer: [
      "You list the products for sale on a market stall photo so each one can be cut out for the trader's catalogue.",
      `List each distinct product once, at most ${MAX_PRODUCTS}. Give a short catalogue name and two short noun phrases`,
      "an image segmentation model can search for: one to three plain words each, one concept, such as \"tomato tin\" or \"milk tin\".",
      "No lists, no negation, no position words (left, top, behind), no brand-only words.",
      "Also give one broad phrase covering most goods on the stall, such as \"packet\" or \"bottle\".",
      "Ignore people, hands, tables, the stall structure, signs, price tags and bags not for sale.",
      "Only list what you can see. Never add products that are not in the photo.",
    ].join(" "),
    user: [
      { type: "input_text", text: "The stall photo:" },
      { type: "input_image", image_url: jpegDataUrl(photo.jpeg) },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["products", "broad_phrase"],
      properties: {
        products: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "phrase_a", "phrase_b"],
            properties: { name: { type: "string" }, phrase_a: { type: "string" }, phrase_b: { type: "string" } },
          },
        },
        broad_phrase: { type: "string" },
      },
    },
  })) as { products?: unknown; broad_phrase?: unknown };

  const products: Proposal[] = [];
  for (const item of Array.isArray(out.products) ? out.products : []) {
    const p = rec(item);
    const name = str(p.name).slice(0, 60);
    const phrases = [...new Set([p.phrase_a, p.phrase_b].map((x) => cleanPhrase(str(x))).filter((x): x is string => !!x))];
    if (name && phrases.length > 0) products.push({ name, phrases });
    if (products.length === MAX_PRODUCTS) break;
  }
  return { products, broad: cleanPhrase(str(out.broad_phrase)) };
}

/** A padded crop around a mask, small enough to review cheaply. */
async function reviewCrop(photo: Photo, m: Mask): Promise<Uint8Array> {
  const padX = Math.round(m.width * 0.15);
  const padY = Math.round(m.height * 0.15);
  const left = Math.max(0, m.left - padX);
  const top = Math.max(0, m.top - padY);
  const width = Math.min(photo.width, m.left + m.width + padX) - left;
  const height = Math.min(photo.height, m.top + m.height + padY) - top;
  const buf = await sharp(photo.jpeg)
    .extract({ left, top, width, height })
    .resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: false })
    .jpeg({ quality: 80 })
    .toBuffer();
  return new Uint8Array(buf);
}

/**
 * Spark's verdict per candidate. A candidate with no clear verdict counts as rejected.
 * With `known` (products already cut out), a crop Spark says is one of them is rejected too.
 */
export async function reviewCandidates(
  client: MetaClient,
  jobId: string,
  photo: Photo,
  candidates: readonly Candidate[],
  known: readonly string[] = [],
): Promise<Candidate[]> {
  const kept: Candidate[] = [];
  const verdictProps: Record<string, unknown> = { crop: { type: "integer" }, sellable: { type: "boolean" }, name: { type: "string" } };
  if (known.length > 0) verdictProps.same_as = { type: "integer" };
  for (let start = 0; start < candidates.length; start += REVIEW_BATCH) {
    const batch = candidates.slice(start, start + REVIEW_BATCH);
    const user: UserPart[] = [];
    for (const [i, c] of batch.entries()) {
      user.push({ type: "input_text", text: `Crop ${i + 1} (suggested name: ${c.name}):` });
      user.push({ type: "input_image", image_url: jpegDataUrl(await reviewCrop(photo, c)) });
    }
    const out = (await sparkJson(client, {
      jobId,
      what: `spark review ${batch.length} crops`,
      name: "crop_review",
      maxOutputTokens: 6000,
      developer: [
        "Each crop is one region an image segmentation model found on a market stall photo.",
        "For each crop, decide whether it shows one sellable product, or a neat group of the same product, clearly enough for a catalogue.",
        "Reject people, hands, tables, the stall, signs, price tags, empty background, a small part of a product, and crops mixing different products.",
        "For an accepted crop give a short catalogue name for what you see; for a rejected crop give an empty name.",
        "Give exactly one verdict per crop, using its crop number.",
        ...(known.length > 0
          ? [
              `These products are already in the catalogue: ${known.map((n, i) => `${i + 1}. ${n}`).join("; ")}.`,
              "If a crop shows one of them (another item, pack or angle of the same product), set same_as to its number; otherwise set same_as to 0.",
            ]
          : []),
      ].join(" "),
      user,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["verdicts"],
        properties: {
          verdicts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: Object.keys(verdictProps),
              properties: verdictProps,
            },
          },
        },
      },
    })) as { verdicts?: unknown };

    const verdicts = new Map<number, { sellable: boolean; name: string } | null>();
    for (const item of Array.isArray(out.verdicts) ? out.verdicts : []) {
      const v = rec(item);
      const crop = v.crop;
      if (typeof crop !== "number" || !Number.isInteger(crop) || crop < 1 || crop > batch.length) continue;
      const sellable = v.sellable;
      // Two verdicts for one crop that disagree count as no verdict.
      // A product already in the catalogue counts as rejected; with `known`, a missing same_as does too.
      const repeat = known.length > 0 && v.same_as !== 0;
      const next = typeof sellable === "boolean" ? { sellable: sellable && !repeat, name: str(v.name).slice(0, 60) } : null;
      const prev = verdicts.get(crop);
      verdicts.set(crop, prev === undefined ? next : prev && next && prev.sellable === next.sellable ? prev : null);
    }
    for (const [i, c] of batch.entries()) {
      const v = verdicts.get(i + 1);
      // An accepted crop needs a name: from review, or the one it was found under. Broad-phrase crops have none of their own.
      const name = v?.name || c.name;
      if (v?.sellable && name) kept.push({ ...c, name });
    }
  }
  return kept;
}

/** Boxes, in photo pixels, round sellable products none of the kept cut-outs covers. */
export async function findMissed(client: MetaClient, jobId: string, photo: Photo, kept: readonly Candidate[]): Promise<{ name: string; box: ReturnType<typeof boxOf> }[]> {
  const listed = kept.map((k) => ({ name: k.name, ...toGrid(boxOf(k), photo) }));
  const out = (await sparkJson(client, {
    jobId,
    what: "spark find missed products",
    name: "missed_products",
    maxOutputTokens: 8000,
    developer: [
      "A market stall photo and the boxes of products already cut out are given. Coordinates are on a 0 to 1000 grid:",
      "x from the left edge, y from the top edge.",
      "Each listed product is done, including every other item, pack or heap of that same product anywhere in the photo.",
      `List only different sellable products you can clearly see that no listed box covers, at most ${MAX_BOXES}, each with a short name and a tight box.`,
      "List each different product once, even if there are many of it.",
      "Ignore people, tables, the stall, signs and price tags. If nothing was missed, return an empty list. Never guess.",
    ].join(" "),
    user: [
      { type: "input_text", text: `Already cut out: ${JSON.stringify(listed)}` },
      { type: "input_image", image_url: jpegDataUrl(photo.jpeg) },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["missed"],
      properties: {
        missed: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "x1", "y1", "x2", "y2"],
            properties: { name: { type: "string" }, x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" } },
          },
        },
      },
    },
  })) as { missed?: unknown };

  const boxes: { name: string; box: ReturnType<typeof boxOf> }[] = [];
  for (const m of Array.isArray(out.missed) ? out.missed : []) {
    const g = rec(m);
    const name = str(g.name).slice(0, 60);
    const box = fromGrid({ x1: Number(g.x1), y1: Number(g.y1), x2: Number(g.x2), y2: Number(g.y2) }, photo);
    if (!name || !box) continue;
    if (kept.some((k) => iou(boxOf(k), box) > 0.5) || boxes.some((b) => iou(b.box, box) > 0.5)) continue;
    boxes.push({ name, box });
    if (boxes.length === MAX_BOXES) break;
  }
  return boxes;
}

/** Runs `fn` over `items`, `limit` at a time. After one fails, no new item starts. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !failed) {
        const i = next++;
        try {
          out[i] = await fn(items[i]!);
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    }),
  );
  return out;
}

/** People, oversized masks (tables, the whole stall) and duplicates removed. */
function usable<T extends Mask>(masks: readonly T[], people: readonly Mask[], photo: Photo): T[] {
  const maxArea = MAX_MASK_SHARE * photo.width * photo.height;
  return dedupe(dropPeople(masks.filter((m) => m.area <= maxArea), people));
}

/**
 * One candidate per proposed product (its most confident instance, so 40 tins
 * or a heap of tomatoes give one cut-out), plus at most MAX_BROAD_EXTRAS
 * broad-phrase masks that aren't already one of those products.
 */
function onePerProduct(masks: readonly Candidate[]): Candidate[] {
  const best = new Map<number, Candidate>();
  const extras: Candidate[] = [];
  for (const m of [...masks].sort((a, b) => b.confidence - a.confidence)) {
    if (m.product === undefined) {
      if (extras.length < MAX_BROAD_EXTRAS) extras.push(m);
    } else if (!best.has(m.product)) {
      best.set(m.product, m);
    }
  }
  return [...best.values(), ...extras];
}

/**
 * Runs steps 1 to 5. The result is in reading order: top to bottom, then left to right.
 * Paid calls are bounded whatever the photo holds: 1 proposal, at most 2 x 12 + 2
 * SAM phrases, at most 3 reviews of 18 candidates, 1 missed-products call, 1 box
 * request and at most 2 reviews of 16 box masks: 35 in all.
 */
export async function findProducts(client: MetaClient, jobId: string, photo: Photo): Promise<Cutout[]> {
  const { products, broad } = await proposeProducts(client, jobId, photo);

  const queries: { phrase: string; product?: number }[] = [];
  const seen = new Set<string>();
  products.forEach((p, i) => {
    for (const phrase of p.phrases) if (!seen.has(phrase)) (seen.add(phrase), queries.push({ phrase, product: i }));
  });
  if (broad && !seen.has(broad)) queries.push({ phrase: broad });

  const [people = [], ...found] = await mapLimit([{ phrase: "person" }, ...queries], SAM_PARALLEL, (q) => segmentPhrase(client, jobId, photo, q.phrase));
  const candidates: Candidate[] = found.flatMap((masks, i) => {
    const q = queries[i]!;
    return masks.map((m) => (q.product === undefined ? { ...m, name: "" } : { ...m, name: products[q.product]!.name, product: q.product }));
  });

  const kept = await reviewCandidates(client, jobId, photo, onePerProduct(usable(candidates, people, photo)));
  const cutouts: Cutout[] = kept.map((k) => ({ name: k.name, mask: k, source: "phrase" }));

  const missed = await findMissed(client, jobId, photo, kept);
  if (missed.length > 0) {
    const masks = await segmentBoxes(client, jobId, photo, missed.map((m) => m.box));
    // Box masks get every check phrase masks get: people, size, duplicates, overlap with kept cut-outs, and review.
    const fromBoxes: Candidate[] = usable(
      masks.map((m) => ({ ...m, name: missed[Number(m.objectId)]?.name ?? "" })),
      people,
      photo,
    ).filter((m) => m.name && kept.every((k) => overlap(k, m) <= 0.3 * Math.min(k.area, m.area)));
    // A box Spark reviews as a product already kept is dropped, and so is a second box with a kept or repeated name.
    const names = new Set(kept.map((k) => sameName(k.name)));
    for (const m of await reviewCandidates(client, jobId, photo, fromBoxes, kept.map((k) => k.name))) {
      if (names.has(sameName(m.name))) continue;
      names.add(sameName(m.name));
      cutouts.push({ name: m.name, mask: m, source: "box" });
    }
  }

  return cutouts.sort((a, b) => a.mask.top - b.mask.top || a.mask.left - b.mask.left);
}

/** A product name reduced for comparison: "Tomato Tins" and "tomato tin" match. */
const sameName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/(\w{3,})s\b/g, "$1");

/** A transparent PNG of one product, cut from the photo's own pixels with its mask. */
export async function cutoutPng(photo: Photo, mask: Mask): Promise<Uint8Array> {
  const rgb = await sharp(photo.jpeg).extract({ left: mask.left, top: mask.top, width: mask.width, height: mask.height }).removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(mask.width * mask.height * 4);
  for (let i = 0; i < mask.width * mask.height; i++) {
    rgba[i * 4] = rgb[i * 3]!;
    rgba[i * 4 + 1] = rgb[i * 3 + 1]!;
    rgba[i * 4 + 2] = rgb[i * 3 + 2]!;
    rgba[i * 4 + 3] = mask.bits[i] ? 255 : 0;
  }
  const png = await sharp(rgba, { raw: { width: mask.width, height: mask.height, channels: 4 } }).png().toBuffer();
  return new Uint8Array(png);
}
