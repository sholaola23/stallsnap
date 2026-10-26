// QA tool: `bun scripts/check-page.ts [out-dir]`
// Publishes a sample catalogue (plain drawn shapes standing in for cut-outs,
// clearly not real products), serves it, then takes 320, 375, 768 and 1280 px
// screenshots and runs axe. Needs Playwright with Chromium.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { publishCatalogue, serveCatalogue } from "../src/catalogue/publish.ts";
import { newSession } from "../src/whatsapp/sessions.ts";

const out = process.argv[2] ?? ".data/page-check";
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "page-check-"));

const shapes: [string, string, number | null, string | null][] = [
  ["Sample tin (red)", "#c0392b", 650, "tin"],
  ["Sample sachet (blue)", "#1f5fa8", 100, "sachet"],
  ["Sample bag (green)", "#2e7d32", 6000, "paint bucket"],
  ["Sample item without a price", "#8e44ad", null, null],
  ["Sample bottle (orange)", "#d35400", 1800, "bottle"],
];
const s = newSession("0", "job-sample");
for (const [i, [name, colour, naira, unit]] of shapes.entries()) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${300 + i * 40}"><rect x="40" y="30" rx="40" width="320" height="${240 + i * 40}" fill="${colour}"/></svg>`;
  const file = join(dir, `item-${i + 1}.png`);
  writeFileSync(file, await sharp(Buffer.from(svg)).png().toBuffer());
  s.items.push({ item: i + 1, name, file });
  s.lines.push({ item: i + 1, name, price: naira === null ? null : { naira, unit: unit as never, quote: "sample" }, question: naira === null ? "How much?" : null });
}

const server = Bun.serve({ port: 0, fetch: (req) => serveCatalogue(new URL(req.url).pathname, dir) ?? new Response("", { status: 404 }) });
const url = await publishCatalogue(s, dir, `http://localhost:${server.port}`);

const { chromium } = await import("playwright");
const browser = await chromium.launch();
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const report: string[] = [`Page: ${new URL(url).pathname}`];
for (const width of [320, 375, 768, 1280]) {
  for (const scheme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme, bypassCSP: true }); // only so axe can be injected
    await page.goto(url);
    const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (width === 375 || width === 1280) await page.screenshot({ path: join(out, `catalogue-${width}-${scheme}.png`), fullPage: true });
    await page.addScriptTag({ content: axeSource });
    const axe = (await page.evaluate(async () => {
      // @ts-expect-error axe is injected above
      const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } });
      return { violations: r.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`), passes: r.passes.length };
    })) as { violations: string[]; passes: number };
    report.push(`${width}px ${scheme}: sideways scroll ${scrollX}px; axe ${axe.violations.length} violations${axe.violations.length ? `: ${axe.violations.join(", ")}` : ""}, ${axe.passes} rules passed`);
    await page.close();
  }
}
await browser.close();
server.stop();
rmSync(dir, { recursive: true, force: true });
writeFileSync(join(out, "report.txt"), `${report.join("\n")}\n`);
console.log(report.join("\n"));
