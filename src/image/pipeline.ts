// Stall photo in, real-product cut-outs out: Muse Spark finds the products, SAM 3.1 masks them,
// and each product is cut from the trader's own photo.
import type { MetaClient } from "../meta/client.ts";
import { cutOut, MIN_COVERAGE, type Cutout } from "./cutout.ts";
import { findProducts, type FoundProduct } from "./find.ts";
import { preparePhoto, type StallPhoto } from "./photo.ts";
import { segmentProducts, type ProductMask } from "./segment.ts";

export interface Skipped {
  product: FoundProduct;
  reason: "no mask" | "mask too small";
}

export interface PhotoResult {
  photo: StallPhoto;
  products: FoundProduct[];
  masks: ProductMask[];
  cutouts: Cutout[];
  skipped: Skipped[];
}

export async function photoToCutouts(client: MetaClient, input: Buffer): Promise<PhotoResult> {
  const photo = await preparePhoto(input);
  const products = await findProducts(client, photo);
  const masks = products.length > 0 ? await segmentProducts(client, photo, products) : [];
  const byId = new Map(masks.map((m) => [m.productId, m]));
  const cutouts: Cutout[] = [];
  const skipped: Skipped[] = [];
  for (const product of products) {
    const mask = byId.get(product.id);
    if (!mask) {
      skipped.push({ product, reason: "no mask" });
    } else if (mask.coverage < MIN_COVERAGE) {
      skipped.push({ product, reason: "mask too small" });
    } else {
      cutouts.push(await cutOut(photo, product, mask));
    }
  }
  return { photo, products, masks, cutouts, skipped };
}
