import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTool, startPricing } from "../pricing/agent.ts";
import { handler } from "../server.ts";
import { cataloguePage } from "./page.ts";
import { CatalogueStore, newSlug } from "./store.ts";

const note = "Peak milk na 1,500 each";
const card = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // a stand-in JPEG; the page never decodes it

function pricedState() {
  const state = startPricing([
    { id: 1, name: "Peak milk tin" },
    { id: 2, name: "Indomie <b>carton</b>" },
    { id: 3, name: "Spaghetti" },
  ]);
  applyTool(state, { name: "set_price", arguments: JSON.stringify({ product_id: 1, amount_naira: 1500, unit: "each", quote: "na 1,500" }) }, note);
  return state;
}

function setup() {
  const store = new CatalogueStore(mkdtempSync(join(tmpdir(), "stallsnap-cat-")));
  const cards = new Map([
    [1, card],
    [2, card],
  ]);
  const catalogue = store.publish(pricedState(), cards, "Mama Ngozi's Provisions", newSlug(), new Date("2026-10-30T12:00:00Z"));
  return { store, catalogue, serve: handler(store) };
}

describe("publishing", () => {
  test("only products with a real cut-out are published; unpriced ones say Ask for price", () => {
    const { catalogue } = setup();
    expect(catalogue.items).toEqual([
      { name: "Peak milk tin", amount: 1500, unit: "each", image: "01.jpg" },
      { name: "Indomie <b>carton</b>", amount: null, unit: null, image: "02.jpg" },
    ]);
  });

  test("a product the trader doesn't sell is never published (QA A4)", () => {
    const { store } = setup();
    const state = pricedState();
    const said = "I no dey sell Indomie again";
    applyTool(state, { name: "remove_product", arguments: JSON.stringify({ product_id: 2, quote: said }) }, said);
    const catalogue = store.publish(state, new Map([[1, card], [2, card]]), "Stall");
    expect(catalogue.items.map((i) => i.name)).toEqual(["Peak milk tin"]);
  });

  test("slugs are 12 characters from an unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) expect(newSlug()).toMatch(/^[a-km-np-z2-9]{12}$/);
  });

  test("republishing to the same slug replaces the list", () => {
    const { store, catalogue } = setup();
    const state = pricedState();
    applyTool(state, { name: "set_price", arguments: JSON.stringify({ product_id: 1, amount_naira: 1500, unit: "per tin", quote: "na 1,500" }) }, note);
    store.publish(state, new Map([[1, card]]), "Mama Ngozi's Provisions", catalogue.slug);
    expect(store.get(catalogue.slug)!.items).toEqual([{ name: "Peak milk tin", amount: 1500, unit: "per tin", image: "01.jpg" }]);
  });
});

describe("the page", () => {
  test("shows names, naira prices and units, and escapes everything the trader or model wrote", () => {
    const { catalogue } = setup();
    const html = cataloguePage(catalogue);
    expect(html).toContain("<h1>Mama Ngozi&#39;s Provisions</h1>");
    expect(html).toContain("₦1,500 <span class=\"unit\">each</span>");
    expect(html).toContain("Indomie &lt;b&gt;carton&lt;/b&gt;");
    expect(html).not.toContain("<b>carton</b>");
    expect(html).toContain('<p class="price ask">Ask for price</p>');
    expect(html).toContain("2 items · Prices updated 30 October 2026");
    expect(html).toContain('<html lang="en-GB">');
  });

  test("every picture has alt text and a size, so the layout doesn't jump", () => {
    const html = cataloguePage(setup().catalogue);
    const imgs = html.match(/<img [^>]+>/g)!;
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img).toMatch(/ alt="[^"]+"/);
      expect(img).toContain('width="600" height="600"');
    }
  });

  test("an empty catalogue says so", () => {
    const html = cataloguePage({ slug: "abcdefghjkmn", stallName: "Stall", publishedAt: "2026-10-30T12:00:00Z", items: [] });
    expect(html).toContain("No items yet.");
    expect(html).toContain("0 items");
  });

  test("a single item says item, not items", () => {
    const html = cataloguePage({ slug: "abcdefghjkmn", stallName: "Stall", publishedAt: "2026-10-30T12:00:00Z", items: [{ name: "x", amount: 5, unit: "each", image: "01.jpg" }] });
    expect(html).toContain("1 item ·");
  });
});

describe("the server", () => {
  const get = (serve: (r: Request) => Promise<Response>, path: string, method = "GET") => serve(new Request(`http://localhost${path}`, { method }));

  test("serves the page and its pictures with safe headers", async () => {
    const { serve, catalogue } = setup();
    const page = await get(serve, `/c/${catalogue.slug}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("Peak milk tin");
    const img = await get(serve, `/c/${catalogue.slug}/01.jpg`);
    expect(img.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(new Uint8Array(card));
  });

  test("unknown, malformed and path-escaping requests get 404", async () => {
    const { serve, catalogue } = setup();
    for (const path of [
      "/c/abcdefghjkmn",
      "/c/../../etc/passwd",
      `/c/${catalogue.slug}/catalogue.json`,
      `/c/${catalogue.slug}/..%2F..%2Fpasswd`,
      `/c/${catalogue.slug}/03.jpg`,
      `/c/${catalogue.slug.toUpperCase()}`,
      "/",
    ]) {
      expect((await get(serve, path)).status).toBe(404);
    }
  });

  test("only GET and HEAD are allowed", async () => {
    const { serve, catalogue } = setup();
    expect((await get(serve, `/c/${catalogue.slug}`, "POST")).status).toBe(405);
  });
});
