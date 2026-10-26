// Messy-input suite: what reaches the public catalogue page.
import { expect, test } from "bun:test";
import { CATALOGUE_TITLE, renderCatalogue } from "../../src/catalogue/page.ts";
import { publishCatalogue } from "../../src/catalogue/publish.ts";
import { newSession } from "../../src/whatsapp/sessions.ts";

const page = (names: string[], extra: Partial<{ naira: number | null; unit: string | null }> = {}) =>
  renderCatalogue({ title: CATALOGUE_TITLE, updatedAt: "not a date", items: names.map((name, i) => ({ name, naira: 100, unit: "piece", image: `item-${i + 1}.webp`, width: 10, height: 10, ...extra })) }, "/c/x");

test("script and markup in item names are shown as text", () => {
  const html = page(['<script>alert(1)</script>', 'Rice" onerror="x', "Tom & Jerry's"]);
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain('alt="Rice&quot; onerror=&quot;x"');
  expect(html).toContain("Tom &amp; Jerry&#39;s");
});

test("emoji and very long names render without breaking the layout rules", () => {
  const html = page(["🍅 Tomato", "x".repeat(300)]);
  expect(html).toContain("🍅 Tomato");
  expect(html).toContain("overflow-wrap: anywhere");
});

test("a date that can't be read is left out, not shown as Invalid Date", () => {
  expect(page(["Rice"])).not.toContain("Invalid Date");
});

test("a price with no unit shows the price alone; a null price never shows a number", () => {
  expect(page(["Rice"], { unit: null })).toContain("₦100</p>");
  expect(page(["Rice"], { naira: null, unit: "bag" })).toContain("Ask for price");
});

test("an empty list is never published", async () => {
  await expect(publishCatalogue(newSession("4477", "job-x"), "/tmp/never-written", "https://x.test")).rejects.toThrow("Nothing to publish");
});

test("a line without its cut-out is never published", async () => {
  const s = newSession("4477", "job-x");
  s.lines = [{ item: 1, name: "Rice", price: null, question: "How much?" }];
  await expect(publishCatalogue(s, "/tmp/never-written", "https://x.test")).rejects.toThrow("no cut-out");
});
