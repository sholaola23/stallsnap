// Development only: `bun src/pipeline/try-cutouts.ts <photo.jpg> [out-dir]`
// Cuts out the products on one photo with the real models and writes a PNG per
// product. Responses are cached in .cache/, so a rerun costs nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEnv } from "../env.ts";
import { MetaClient } from "../meta/client.ts";
import { DEFAULT_LEDGER_PATH, SpendGuard } from "../spend-guard.ts";
import { cutoutPng, findProducts } from "./cutouts.ts";
import { preparePhoto } from "./photo.ts";

const [photoPath, outDir = ".data/try-cutouts"] = process.argv.slice(2);
const apiKey = readEnv("MODEL_API_KEY");
if (!photoPath || !apiKey) {
  console.error(apiKey ? "Usage: bun src/pipeline/try-cutouts.ts <photo.jpg> [out-dir]" : "MODEL_API_KEY is not set");
  process.exit(1);
}

const guard = new SpendGuard({ ledgerPath: DEFAULT_LEDGER_PATH });
const before = guard.spentToday();
const client = new MetaClient({ apiKey, guard, cacheDir: ".cache/meta" });
const photo = await preparePhoto(new Uint8Array(readFileSync(photoPath)));
const started = Date.now();
const cutouts = await findProducts(client, `try-${Date.now()}`, photo);

mkdirSync(outDir, { recursive: true });
for (const [i, c] of cutouts.entries()) {
  const file = join(outDir, `${String(i + 1).padStart(2, "0")}-${c.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
  writeFileSync(file, await cutoutPng(photo, c.mask));
  console.log(`${file}  ${c.source}  confidence ${c.mask.confidence.toFixed(2)}`);
}
console.log(`${cutouts.length} products in ${((Date.now() - started) / 1000).toFixed(1)} s, spent $${(guard.spentToday() - before).toFixed(4)}`);
