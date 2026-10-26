import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import { TRADER, harness, msg } from "../whatsapp/test-conversation.ts";
import { CATALOGUE_TITLE, priceText, renderCatalogue } from "./page.ts";
import { newSlug, publishCatalogue, serveCatalogue } from "./publish.ts";
import { Conversation } from "../whatsapp/conversation.ts";

let h: ReturnType<typeof harness> | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

/** A cut-out: red product on the left half, transparent on the right. */
async function realPng() {
  const w = 900;
  const hgt = 600;
  const rgba = Buffer.alloc(w * hgt * 4);
  for (let i = 0; i < w * hgt; i++) if (i % w < w / 2) rgba.set([200, 30, 30, 255], i * 4);
  return new Uint8Array(await sharp(rgba, { raw: { width: w, height: hgt, channels: 4 } }).png().toBuffer());
}

/** Runs a trader through to "Yes, publish" with the real publisher. */
async function publishedThroughWhatsApp() {
  const h = harness();
  hold(h);
  const png = await realPng();
  const conversation = new Conversation({
    store: h.store,
    log: h.log,
    messenger: {
      sendText: async (to: string, body: string) => (h.sent.push({ kind: "text", to, body }), "w"),
      sendButton: async (to: string, body: string, b: { id: string }) => (h.sent.push({ kind: "button", to, body, id: b.id }), "w"),
      sendLink: async (to: string, body: string, _t: string, url: string) => (h.sent.push({ kind: "link", to, body, url }), "w"),
      typing: async () => {},
      download: async (id: string) => ({ bytes: id.startsWith("photo") ? new Uint8Array(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#c84" } }).jpeg().toBuffer()) : new TextEncoder().encode(id), mimeType: "x" }),
    },
    models: {
      toWav: async (b) => ({ bytes: b, durationMs: 1000 }),
      cutouts: async () => [{ name: "Rice", png }, { name: "Garri <b>", png }, { name: "Beans", png }],
      transcribe: async (_j, wav) => new TextDecoder().decode(wav.bytes),
      price: async (_j, items) => ({
        lines: items.map((i) => (i.item === 3 ? { ...i, price: null, question: "How much is Beans?" } : { ...i, price: { naira: i.item * 1500, unit: "bag" as const, quote: "q" }, question: null })),
        events: [],
        turns: 1,
        stopped: "all-done" as const,
      }),
    },
    publish: (s) => publishCatalogue(s, h.dir, "https://stall.example"),
    dataDir: h.dir,
    now: () => 1_000_000, // test messages carry small timestamps
  });
  await conversation.handle(msg.photo());
  await conversation.handle(msg.voice("prices"));
  await conversation.handle(msg.text("no idea about beans"));
  await conversation.handle(msg.text("yes"));
  return { url: h.store.get(TRADER)!.url!, dir: h.dir };
}
const hold = (x: ReturnType<typeof harness>) => (h = x);

describe("publishing through WhatsApp", () => {
  test("the confirmed list becomes a page at a random link, with the title, prices and 'Ask for price'", async () => {
    const { url, dir } = await publishedThroughWhatsApp();
    expect(url).toMatch(/^https:\/\/stall\.example\/c\/[a-z2-7]{16}$/);
    expect(url).not.toContain(TRADER);
    const path = new URL(url).pathname;

    const res = serveCatalogue(path, dir)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain(`<title>${CATALOGUE_TITLE}</title>`);
    expect(html).toContain(`<h1>${CATALOGUE_TITLE}</h1>`);
    expect(html).toContain("₦1,500 per bag");
    expect(html).toContain("₦3,000 per bag");
    expect(html).toContain('<p class="price ask">Ask for price</p>');
    expect(html).toContain("Garri &lt;b&gt;");
    expect(html).not.toContain("Garri <b>");
    expect(html).not.toContain(TRADER);

    const img = serveCatalogue(`${path}/item-1.webp`, dir)!;
    expect(img.headers.get("content-type")).toBe("image/webp");
    const meta = await sharp(new Uint8Array(await img.arrayBuffer())).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBe(480);
    expect(meta.hasAlpha).toBe(true);
  });
});

describe("serving", () => {
  test("unknown, malformed and traversal paths are 404s, and non-catalogue paths fall through", async () => {
    const { url, dir } = await publishedThroughWhatsApp();
    const slug = new URL(url).pathname.split("/")[2]!;
    for (const p of ["/c/aaaaaaaaaaaaaaaa", "/c/short", `/c/${slug.toUpperCase()}`, `/c/${slug}/catalogue.json`, `/c/${slug}/item-1.png`, `/c/${slug}/..%2Fsessions.json`, "/c/../sessions.json", `/c/${slug}/item-99.webp`]) {
      expect(serveCatalogue(p, dir)?.status).toBe(404);
    }
    expect(serveCatalogue("/webhook", dir)).toBeUndefined();
    expect(await serveCatalogue("/robots.txt", dir)!.text()).toContain("User-agent: *");
  });
});

describe("page", () => {
  test("priceText", () => {
    expect(priceText({ naira: 6000, unit: "paint bucket" })).toBe("₦6,000 per paint bucket");
    expect(priceText({ naira: null, unit: null })).toBe("Ask for price");
  });

  test("images after the fourth load lazily; every image has alt text and a size", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ name: `Item ${i}`, naira: 100, unit: "piece", image: `item-${i + 1}.webp`, width: 480, height: 320 }));
    const html = renderCatalogue({ title: CATALOGUE_TITLE, items, updatedAt: "2026-10-26T12:00:00Z" }, "/c/x");
    expect((html.match(/loading="lazy"/g) ?? []).length).toBe(2);
    expect((html.match(/<img [^>]*alt="Item \d" width="480" height="320"/g) ?? []).length).toBe(6);
    expect(html).toContain("Prices from 26 October 2026");
    expect(html).toContain('lang="en-GB"');
  });

  test("slugs are 16 random base32 characters", () => {
    const a = newSlug();
    expect(a).toMatch(/^[a-z2-7]{16}$/);
    expect(newSlug()).not.toBe(a);
  });
});
