// bun run restyle <cutouts-out-dir> [how-many]
// Restyles the first few catalogue cards from a `bun run cutouts` run with Muse Image and writes,
// for each, NN-clean.jpg (what would be published) and NN-compare.jpg (cut-out | Muse Image).
// Paid calls need STALLSNAP_LIVE=1 and MODEL_API_KEY; each picture costs $0.01.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { MetaClient } from "../meta/client.ts";
import { Budget, budgetFromEnv } from "../meta/spend.ts";
import { likeness, restyleCard, restyleRequest } from "./restyle.ts";

const [dir, countArg] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: bun run restyle <cutouts-out-dir> [how-many]");
  process.exit(1);
}
const count = Number(countArg ?? 3);
const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { products: { id: number; name: string }[] };
const cards = readdirSync(dir).filter((f) => f.endsWith("-card.jpg")).sort().slice(0, count);
const budget = new Budget(budgetFromEnv());
const client = new MetaClient({ budget, apiKey: process.env.MODEL_API_KEY });

for (const file of cards) {
  const id = Number(file.slice(0, 2));
  const name = summary.products.find((p) => p.id === id)?.name ?? "product";
  const card = readFileSync(join(dir, file));
  const result = await restyleCard(client, card, name);
  const prefix = file.slice(0, 2);
  writeFileSync(join(dir, `${prefix}-clean.jpg`), result.card);
  // Show Muse Image's own picture next to the cut-out even when it was refused, for review.
  const raw = (await client.editImage(restyleRequest(card, name)).catch(() => null))?.data?.[0]?.b64_json;
  const right = raw
    ? await sharp(Buffer.from(raw, "base64")).flatten({ background: "#ffffff" }).resize(600, 600, { fit: "contain", background: "#ffffff" }).jpeg().toBuffer()
    : card;
  const compare = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#ffffff" } })
    .composite([{ input: card, left: 0, top: 0 }, { input: right, left: 600, top: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
  writeFileSync(join(dir, `${prefix}-compare.jpg`), compare);
  const like = raw ? await likeness(card, right) : null;
  console.log(`${prefix} ${name}: ${result.restyled ? "restyled" : "plain cut-out"} (${result.reason})${like ? ` change=${like.colourChange.toFixed(1)} added=${(like.newShapes * 100).toFixed(1)}%` : ""}`);
}
console.log(`Paid calls: ${budget.paidCalls}, spend this run: $${budget.runSpendUsd.toFixed(4)}.`);
