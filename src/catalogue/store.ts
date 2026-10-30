// Published catalogues live on disk: data/catalogues/<slug>/catalogue.json plus one card per product.
// The slug is random, so a catalogue is only found through the link the trader shares.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PricingState } from "../pricing/agent.ts";

export interface CatalogueItem {
  name: string;
  amount: number | null; // null shows as "Ask for price"
  unit: string | null;
  image: string; // file name inside the catalogue folder
}

export interface Catalogue {
  slug: string;
  stallName: string;
  publishedAt: string;
  items: CatalogueItem[];
}

const SLUG = /^[a-z0-9]{12}$/;

export function newSlug(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]).join("");
}

export class CatalogueStore {
  constructor(readonly root = "data/catalogues") {}

  // Writes every file under a temporary name first, so a reader never sees half a catalogue.
  publish(state: PricingState, cards: ReadonlyMap<number, Buffer>, stallName: string, slug = newSlug(), now = new Date()): Catalogue {
    if (!SLUG.test(slug)) throw new Error(`bad catalogue slug: ${slug}`);
    const dir = join(this.root, slug);
    mkdirSync(dir, { recursive: true });
    const items: CatalogueItem[] = [];
    for (const line of state.lines) {
      const card = cards.get(line.productId);
      // A product without a real cut-out never reaches the page.
      if (!card) continue;
      const image = `${String(line.productId).padStart(2, "0")}.jpg`;
      writeFileSync(join(dir, image), card);
      items.push({ name: line.name, amount: line.amount, unit: line.amount === null ? null : line.unit, image });
    }
    const catalogue: Catalogue = { slug, stallName, publishedAt: now.toISOString(), items };
    writeFileSync(join(dir, "catalogue.json.tmp"), JSON.stringify(catalogue, null, 2));
    renameSync(join(dir, "catalogue.json.tmp"), join(dir, "catalogue.json"));
    return catalogue;
  }

  get(slug: string): Catalogue | null {
    if (!SLUG.test(slug)) return null;
    const path = join(this.root, slug, "catalogue.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Catalogue;
  }

  image(slug: string, file: string): Buffer | null {
    if (!SLUG.test(slug) || !/^\d{2,3}\.jpg$/.test(file)) return null;
    const path = join(this.root, slug, file);
    return existsSync(path) ? readFileSync(path) : null;
  }
}
