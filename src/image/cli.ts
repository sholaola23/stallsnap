// bun run cutouts <stall-photo> [out-dir]
// Writes the cut-outs, white catalogue cards, a mask overlay and a summary JSON.
// Paid calls need STALLSNAP_LIVE=1 and MODEL_API_KEY; cached answers are reused for free.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { MetaClient } from "../meta/client.ts";
import { Budget, budgetFromEnv } from "../meta/spend.ts";
import { overlay } from "./cutout.ts";
import { photoToCutouts } from "./pipeline.ts";

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
}

const [photoPath, outArg] = process.argv.slice(2);
if (!photoPath) {
  console.error("Usage: bun run cutouts <stall-photo> [out-dir]");
  process.exit(1);
}
const outDir = outArg ?? join("out", basename(photoPath, extname(photoPath)));
const budget = new Budget(budgetFromEnv());
const client = new MetaClient({ budget, apiKey: process.env.MODEL_API_KEY });

const result = await photoToCutouts(client, readFileSync(photoPath));
mkdirSync(outDir, { recursive: true });
for (const cut of result.cutouts) {
  const name = `${String(cut.productId).padStart(2, "0")}-${slug(cut.name)}`;
  writeFileSync(join(outDir, `${name}.png`), cut.png);
  writeFileSync(join(outDir, `${name}-card.jpg`), cut.card);
}
writeFileSync(join(outDir, "overlay.jpg"), await overlay(result.photo, result.products, result.masks));
const summary = {
  photo: photoPath,
  size: { width: result.photo.width, height: result.photo.height },
  products: result.products.map((p) => ({
    ...p,
    coverage: Number((result.masks.find((m) => m.productId === p.id)?.coverage ?? 0).toFixed(3)),
  })),
  skipped: result.skipped.map((s) => ({ id: s.product.id, name: s.product.name, reason: s.reason })),
  paidCalls: budget.paidCalls,
  spendUsd: Number(budget.runSpendUsd.toFixed(4)),
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  `${result.products.length} products found, ${result.cutouts.length} cut out, ${result.skipped.length} skipped. ` +
    `Paid calls: ${budget.paidCalls}, spend this run: $${budget.runSpendUsd.toFixed(4)}. Written to ${outDir}`,
);
