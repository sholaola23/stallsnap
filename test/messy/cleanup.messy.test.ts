// Messy-input suite: Muse Image results that must not reach a catalogue.
import { beforeAll, expect, test } from "bun:test";
import sharp from "sharp";
import { MAX_BACKGROUND_SPREAD, MAX_PRODUCT_DRIFT, compare } from "../../src/pipeline/cleanup.ts";

const W = 300;
const H = 200;
let cut: Uint8Array;
beforeAll(async () => {
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 20; y < 180; y++) for (let x = 30; x < 180; x++) rgba.set(y % 20 < 10 ? [190, 40, 40, 255] : [240, 220, 60, 255], (y * W + x) * 4);
  cut = new Uint8Array(await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer());
});
const flat = () => sharp(cut).flatten({ background: "#fafafa" });
const passes = (r: { drift: number; spread: number }) => r.drift <= MAX_PRODUCT_DRIFT && r.spread <= MAX_BACKGROUND_SPREAD;

test("refused: product turned greyscale", async () => {
  expect(passes(await compare(cut, new Uint8Array(await flat().greyscale().png().toBuffer())))).toBe(false);
});
test("refused: product recoloured", async () => {
  expect(passes(await compare(cut, new Uint8Array(await flat().tint({ r: 30, g: 120, b: 220 }).png().toBuffer())))).toBe(false);
});
test("refused: product moved", async () => {
  const moved = await sharp(cut).extend({ left: 15, background: { r: 0, g: 0, b: 0, alpha: 0 } }).extract({ left: 0, top: 0, width: W, height: H }).flatten({ background: "#fafafa" }).png().toBuffer();
  expect(passes(await compare(cut, new Uint8Array(moved)))).toBe(false);
});
test("refused: a second product drawn into the background", async () => {
  const extra = await sharp(await flat().png().toBuffer()).composite([{ input: { create: { width: 60, height: 60, channels: 3, background: "#204080" } }, left: 220, top: 120 }]).png().toBuffer();
  expect(passes(await compare(cut, new Uint8Array(extra)))).toBe(false);
});
test("refused: an all-black image", async () => {
  const black = await sharp({ create: { width: W, height: H, channels: 3, background: "#000" } }).png().toBuffer();
  expect(passes(await compare(cut, new Uint8Array(black)))).toBe(false);
});
test("accepted: brighter, a little more contrast, JPEG artefacts, grey background", async () => {
  for (const img of [flat().linear(1, 20), flat().linear(1.15, -10), flat().jpeg({ quality: 60 }), sharp(cut).flatten({ background: "#d8d8d8" })]) {
    expect(passes(await compare(cut, new Uint8Array(await img.toBuffer())))).toBe(true);
  }
});

// QA round 1 on PR #10: Muse replies that change the product in a small area,
// add something next to it, or never answer. Every attack is kept as a test.
import { describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../../src/meta/client.ts";
import { cleanUp } from "../../src/pipeline/cleanup.ts";
import { SpendGuard } from "../../src/spend-guard.ts";

describe("QA round 1 on PR #10", () => {
  const TW = 300;
  const TH = 400;
  // A red tin with a cream label. The "lettering" is drawn as bars, so the test needs no fonts.
  const BRANDS = { PEAK: [10, 40, 70, 100, 130], COWBELL: [20, 35, 50, 95, 110, 125, 140] } as const;
  const tinSvg = (o: { body?: string; label?: readonly number[] | null; background?: string; extra?: string }) => {
    const bars = (o.label ?? []).map((x) => `<rect x="${70 + x}" y="175" width="8" height="50" fill="#202020"/>`).join("");
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TW}" height="${TH}">
      ${o.background ? `<rect width="${TW}" height="${TH}" fill="${o.background}"/>` : ""}
      <rect x="60" y="40" width="180" height="320" fill="${o.body ?? "#c03030"}"/>
      <rect x="60" y="150" width="180" height="100" fill="#f4e8c8"/>${bars}
      ${o.extra ? `<rect x="240" y="300" width="24" height="40" fill="${o.extra}"/>` : ""}
    </svg>`);
  };
  const png = async (svg: Buffer) => new Uint8Array(await sharp(svg).png().toBuffer());
  let tin: Uint8Array;
  let dir: string;
  let guard: SpendGuard;
  beforeAll(async () => {
    tin = await png(tinSvg({ label: [...BRANDS.PEAK] }));
  });

  /** A MetaClient whose /images/edits answers with `reply` (an image, a Response, or a hang). */
  function museClient(replies: (Uint8Array | Response | "hang")[], timeoutMs = 50) {
    dir = mkdtempSync(join(tmpdir(), "cleanup-qa-"));
    guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
    let n = 0;
    const fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      const r = replies[Math.min(n++, replies.length - 1)]!;
      if (r === "hang") {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));
      }
      if (r instanceof Response) return r;
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(r).toString("base64") }] }));
    }) as typeof globalThis.fetch;
    return { client: new MetaClient({ apiKey: "k", guard, fetch, timeoutMs, sleep: async () => {} }), count: () => n, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** True when every fully opaque pixel of the trader's cut-out is unchanged in `out`. */
  async function productIsTheTraders(out: Uint8Array): Promise<boolean> {
    const a = await sharp(tin).ensureAlpha().raw().toBuffer();
    const b = await sharp(out).resize({ width: TW, height: TH, fit: "fill" }).removeAlpha().raw().toBuffer();
    for (let i = 0; i < TW * TH; i++) {
      if (a[i * 4 + 3] !== 255) continue;
      if (a[i * 4] !== b[i * 3] || a[i * 4 + 1] !== b[i * 3 + 1] || a[i * 4 + 2] !== b[i * 3 + 2]) return false;
    }
    return true;
  }

  for (const [name, reply] of [
    ["label swapped to another brand", { label: [...BRANDS.COWBELL] }],
    ["label blanked (wear 'cleaned up')", { label: null }],
    ["colour variant, red to orange", { body: "#d05020", label: [...BRANDS.PEAK] }],
  ] as const) {
    test(`findings 1 to 3: ${name}: whatever Muse did, the published product is the trader's own pixels`, async () => {
      const m = museClient([await png(tinSvg({ ...reply, background: "#fafafa" }))]);
      const r = await cleanUp(m.client, "j", tin);
      expect(await productIsTheTraders(r.png)).toBe(true);
      m.done();
    });
  }

  // Blue gives spread 17.3 and grey 9.1, both under the spread limit of 18: only the stray-pixel count catches them.
  for (const colour of ["#2050c0", "#a0a0a0"]) {
    test(`finding 4: a 24x40 ${colour} item touching the product is refused`, async () => {
      const m = museClient([await png(tinSvg({ label: [...BRANDS.PEAK], background: "#fafafa", extra: colour }))]);
      const r = await cleanUp(m.client, "j", tin);
      expect(r.cleaned).toBe(false);
      expect(r.png).toBe(tin);
      m.done();
    });
  }

  test("finding 5: a Muse call that never answers falls back to the plain cut-out within the timeout", async () => {
    const m = museClient(["hang"], 30);
    const started = Date.now();
    const r = await cleanUp(m.client, "j", tin);
    expect(r.cleaned).toBe(false);
    expect(r.png).toBe(tin);
    expect(Date.now() - started).toBeLessThan(2000);
    m.done();
  });

  test("a 503 then a good image: retried once and cleaned", async () => {
    const m = museClient([new Response('{"error":{"message":"busy"}}', { status: 503 }), await png(tinSvg({ label: [...BRANDS.PEAK], background: "#fafafa" }))]);
    const r = await cleanUp(m.client, "j", tin);
    expect(r.cleaned).toBe(true);
    expect(m.count()).toBe(2);
    m.done();
  });

  test("optional: a solid coloured background is refused", async () => {
    const m = museClient([await png(tinSvg({ label: [...BRANDS.PEAK], background: "#ff40c0" }))]);
    expect((await cleanUp(m.client, "j", tin)).cleaned).toBe(false);
    m.done();
  });

  test("optional: a reply under half the cut-out's size is refused", async () => {
    const small = new Uint8Array(await sharp(tinSvg({ label: [...BRANDS.PEAK], background: "#fafafa" })).resize(30, 40).png().toBuffer());
    const m = museClient([small]);
    expect((await cleanUp(m.client, "j", tin)).cleaned).toBe(false);
    m.done();
  });

  test("good edits are still used: brighter, more contrast, JPEG, slight blur, larger size", async () => {
    const base = () => sharp(tinSvg({ label: [...BRANDS.PEAK], background: "#fafafa" }));
    for (const img of [base().linear(1, 20), base().linear(1.15, -10), base().jpeg({ quality: 60 }), base().blur(0.8), base().resize(600, 800)]) {
      const m = museClient([new Uint8Array(await img.png().toBuffer())]);
      const r = await cleanUp(m.client, "j", tin);
      expect(r.cleaned).toBe(true);
      expect(await productIsTheTraders(r.png)).toBe(true);
      m.done();
    }
  });
});

// QA round 2 on PR #10: a Muse that stops answering must not hold up the trader's link.
import { JobLog } from "../../src/joblog.ts";
import { cleanupStep } from "../../src/pipeline/cleanup.ts";

test("12 items with a Muse that never answers: all plain, well within the shared budget, one call started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cleanup-budget-"));
  const guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
  let fetches = 0;
  const fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    fetches++;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));
  }) as typeof globalThis.fetch;
  // The client's own timeout is long (60 s, 3 attempts): only the shared budget can end this quickly.
  const client = new MetaClient({ apiKey: "k", guard, fetch, timeoutMs: 60_000, sleep: async () => {} });
  const log = new JobLog(join(dir, "joblog.jsonl"));
  log.openJob("pub");
  const plain: string[] = [];
  const step = cleanupStep(log, client, "pub", (_i, r) => plain.push(r), 300);
  const cut = new Uint8Array(await sharp({ create: { width: 120, height: 160, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer());
  const started = Date.now();
  for (let i = 1; i <= 12; i++) {
    const file = join(dir, `item-${i}.png`);
    writeFileSync(file, cut);
    const out = await step({ item: i, file }, cut);
    expect(Buffer.from(out).equals(Buffer.from(cut))).toBe(true);
  }
  expect(Date.now() - started).toBeLessThan(3000);
  expect(plain).toHaveLength(12);
  expect(plain.every((r) => r === "clean-up time budget used")).toBe(true);
  expect(fetches).toBe(1);
  log.close();
  rmSync(dir, { recursive: true, force: true });
});
