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
  expect(html).toContain("<h2>Rice&quot; onerror=&quot;x</h2>");
  expect(html).not.toContain('onerror="x"');
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

// QA round 1 on PR #9: a damaged catalogue file must never show source or a stack trace.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCatalogue } from "../../src/catalogue/publish.ts";

const SLUG = "abcdefghijklmnop";
function damaged(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "cat-damaged-"));
  mkdirSync(join(dir, ".data", "public", SLUG), { recursive: true });
  writeFileSync(join(dir, ".data", "public", SLUG, "catalogue.json"), contents);
  return dir;
}
const leaks = (body: string) => /publish\.ts|page\.ts|at \w+ \(|<html|SyntaxError|TypeError/.test(body);

for (const [name, contents] of [
  ["truncated JSON", '{"title":"StallSnap Demo Stall","items":[{"name":"Ri'],
  ["the wrong shape", '{"title":"x","items":5}'],
  ["empty", ""],
] as const) {
  test(`a catalogue file that is ${name} gets a plain 500 with no source or stack`, async () => {
    const dir = damaged(contents);
    const res = serveCatalogue(`/c/${SLUG}`, join(dir, ".data"))!;
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(leaks(await res.text())).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
}

test("the real server answers a damaged catalogue with a plain 500, not Bun's debug page", async () => {
  const dir = damaged('{"title":"StallSnap Demo Stall","items":[{"name":"Ri');
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const server = Bun.spawn(["bun", join(import.meta.dir, "../../src/server.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", PORT: String(port), APP_SECRET: "qa-app-secret-1", WHATSAPP_VERIFY_TOKEN: "qa-verify-token-1", ALLOWED_NUMBERS: "447700900123" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let res: Response | undefined;
    for (let i = 0; i < 50 && !res; i++) {
      res = await fetch(`http://127.0.0.1:${port}/c/${SLUG}`).catch(() => undefined);
      if (!res) await Bun.sleep(100);
    }
    expect(res!.status).toBe(500);
    const body = await res!.text();
    expect(leaks(body)).toBe(false);
    expect(body.length).toBeLessThan(200);
  } finally {
    server.kill();
    await server.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

// Grok review on PR #9: the page promises no contact route it doesn't give (Shola is still deciding on one).
test("the page doesn't tell customers to message the trader without a way to do it", () => {
  const html = renderCatalogue({ title: CATALOGUE_TITLE, updatedAt: "2026-10-27T09:00:00Z", items: [{ name: "Rice", naira: 1500, unit: "bag", image: "item-1.webp", width: 10, height: 10 }] }, "/c/x");
  expect(html).not.toMatch(/message the trader/i);
  expect(html).toContain("Prices from 27 October 2026.");
});
