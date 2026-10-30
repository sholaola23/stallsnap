// bun run price <cutouts summary.json> <voice note (.ogg, .m4a, .wav...) or transcript .txt> [more notes...]
// Prices the products found in a photo from one or more voice notes, and prints the trader's reply.
// Paid calls need STALLSNAP_LIVE=1 and MODEL_API_KEY; cached answers are reused for free.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { MetaClient } from "../meta/client.ts";
import { Budget, budgetFromEnv } from "../meta/spend.ts";
import { transcribeNote } from "../voice/transcribe.ts";
import { priceNote, replyText, startPricing, type Product } from "./agent.ts";

const [summaryPath, ...notePaths] = process.argv.slice(2);
if (!summaryPath || notePaths.length === 0) {
  console.error("Usage: bun run price <cutouts summary.json> <voice note or transcript.txt> [more notes...]");
  process.exit(1);
}
const budget = new Budget(budgetFromEnv());
const client = new MetaClient({ budget, apiKey: process.env.MODEL_API_KEY });
const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as { products: Product[]; skipped?: { id: number }[] };
// Only products that were actually cut out can go in the catalogue.
const skipped = new Set((summary.skipped ?? []).map((s) => s.id));
const products = summary.products.filter((p) => !skipped.has(p.id)).map(({ id, name }) => ({ id, name }));

try {
  let state = startPricing(products);
  for (const path of notePaths) {
    const transcript =
      extname(path) === ".txt"
        ? readFileSync(path, "utf8").trim()
        : await transcribeNote(client, readFileSync(path), products.map((p) => p.name));
    console.log(`Transcript (${path}):\n${transcript}\n`);
    state = await priceNote(client, state, transcript);
  }
  const out = join(dirname(summaryPath), "prices.json");
  writeFileSync(out, JSON.stringify(state, null, 2));
  console.log(replyText(state));
  console.log(`\nPaid calls: ${budget.paidCalls}, spend this run: $${budget.runSpendUsd.toFixed(4)}. Saved ${out}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
