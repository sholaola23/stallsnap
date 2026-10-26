// Messy-input suite: photos, SAM output and Spark answers for the cut-out step.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../../src/meta/client.ts";
import { SparkError, sparkJson } from "../../src/meta/spark.ts";
import { fakeMeta } from "../../src/meta/test-fakes.ts";
import { findMissed, proposeProducts, reviewCandidates } from "../../src/pipeline/cutouts.ts";
import { cleanPhrase, fromGrid } from "../../src/pipeline/masks.ts";
import { PhotoError, preparePhoto, type Photo } from "../../src/pipeline/photo.ts";
import { readMasks } from "../../src/pipeline/sam.ts";
import { MILK, TOMATO, responseWithText, samText, stallPhoto } from "../../src/pipeline/test-stall.ts";
import { SpendGuard } from "../../src/spend-guard.ts";

let dir: string;
let guard: SpendGuard;
let photo: Photo;
beforeAll(async () => {
  photo = await stallPhoto();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cut-messy-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const clientFor = (body: unknown) => new MetaClient({ apiKey: "k", guard, fetch: fakeMeta(() => body).fetch });

describe("photos that aren't photos", () => {
  for (const [name, bytes] of [
    ["empty", new Uint8Array()],
    ["text", new TextEncoder().encode("hello")],
    ["truncated JPEG header", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
  ] as const) {
    test(name, async () => expect(preparePhoto(bytes)).rejects.toBeInstanceOf(PhotoError));
  }
});

describe("SAM phrases Spark might suggest", () => {
  for (const bad of [
    "tomato tin, milk tin", // list
    "tin and bottle",
    "bottle not empty", // negation
    "tin on the left", // position
    "top shelf tin",
    "🍅 tin", // emoji
    "the big red tomato paste tin with label", // too long
    "",
    "   ",
    "tin; bottle",
    "milk+sugar",
  ]) {
    test(JSON.stringify(bad), () => expect(cleanPhrase(bad)).toBeUndefined());
  }

  test("Spark proposing 20 products is capped at 12, and products whose phrases are all unusable are skipped", async () => {
    const products = Array.from({ length: 20 }, (_, i) => ({ name: `Item ${i}`, phrase_a: i === 0 ? "a, b" : `thing ${i}`, phrase_b: i === 0 ? "c and d" : `thing ${i}` }));
    const out = await proposeProducts(clientFor(responseWithText(JSON.stringify({ products, broad_phrase: "packet on left" }))), "j", photo);
    expect(out.products).toHaveLength(12);
    expect(out.products[0]!.name).toBe("Item 1");
    expect(out.products[0]!.phrases).toEqual(["thing 1"]);
    expect(out.broad).toBeUndefined();
  });

  test("garbage fields in the proposal are skipped", async () => {
    const products = [null, 7, { name: 42, phrase_a: "tin", phrase_b: "tin" }, { name: "Milo", phrase_a: null, phrase_b: "milo tin" }];
    const out = await proposeProducts(clientFor(responseWithText(JSON.stringify({ products, broad_phrase: 5 }))), "j", photo);
    expect(out.products).toEqual([{ name: "Milo", phrases: ["milo tin"] }]);
  });
});

describe("SAM output that isn't clean", () => {
  const size = { width: 400, height: 300 };
  test("empty output is zero matches", () => expect(readMasks("", size)).toEqual([]));
  test("garbage text gives no masks", () => expect(readMasks("<0f>not a record at all", size)).toEqual([]));
  test("a record without confidence is dropped (we always ask for it)", () => {
    const text = samText([{ box: TOMATO, c: 0.9 }]).replace(/;c=0\.9/g, "");
    expect(readMasks(text, size)).toEqual([]);
  });
  test("a mask outside the photo is dropped", () => {
    expect(readMasks(samText([{ box: TOMATO, c: 0.9 }]), { width: 50, height: 50 })).toEqual([]);
  });
  test("exactly 0.5 confidence is kept, just under is dropped", () => {
    expect(readMasks(samText([{ box: TOMATO, c: 0.5 }, { box: MILK, c: 0.49 }]), size)).toHaveLength(1);
  });
});

describe("crop reviews that aren't clean", () => {
  const cand = (box: typeof TOMATO, name: string) => ({ ...readMasks(samText([{ box, c: 0.9 }]), { width: 400, height: 300 })[0]!, name });
  const run = (verdicts: unknown) => reviewCandidates(clientFor(responseWithText(JSON.stringify({ verdicts }))), "j", photo, [cand(TOMATO, "Tomato"), cand(MILK, "Milk")]);

  test("no verdicts means nothing is kept", async () => expect(await run([])).toEqual([]));
  test("null and non-object verdicts are skipped, not a crash", async () => {
    expect((await run([null, 3, "yes", [], { crop: 2, sellable: true, name: "" }])).map((k) => k.name)).toEqual(["Milk"]);
  });
  test("crop numbers out of range or not whole are ignored", async () => {
    expect(await run([{ crop: 0, sellable: true, name: "x" }, { crop: 3, sellable: true, name: "x" }, { crop: 1.5, sellable: true, name: "x" }, { crop: "1", sellable: true, name: "x" }])).toEqual([]);
  });
  test("two verdicts for one crop that disagree count as no verdict", async () => {
    const kept = await run([{ crop: 1, sellable: true, name: "Tomato" }, { crop: 1, sellable: false, name: "" }, { crop: 2, sellable: true, name: "" }]);
    expect(kept.map((k) => k.name)).toEqual(["Milk"]);
  });
  test('sellable as the text "true" is not a yes', async () => {
    expect(await run([{ crop: 1, sellable: "true", name: "Tomato" }])).toEqual([]);
  });
});

describe("missed-product boxes that aren't clean", () => {
  const run = (missed: unknown) => findMissed(clientFor(responseWithText(JSON.stringify({ missed }))), "j", photo, []);
  test("back to front, tiny, NaN and nameless boxes are dropped; out-of-range ones are clamped", async () => {
    const boxes = await run([
      { name: "Back", x1: 600, y1: 600, x2: 500, y2: 500 },
      { name: "Tiny", x1: 10, y1: 10, x2: 11, y2: 11 },
      { name: "NaN", x1: "a", y1: 0, x2: 100, y2: 100 },
      { name: "", x1: 0, y1: 0, x2: 100, y2: 100 },
      null,
      "box",
      { name: "Edge", x1: -50, y1: 900, x2: 1200, y2: 1500 },
    ]);
    expect(boxes).toEqual([{ name: "Edge", box: { left: 0, top: 270, right: 400, bottom: 300 } }]);
  });
  test("two boxes on the same product become one", async () => {
    const boxes = await run([
      { name: "Rice", x1: 700, y1: 533, x2: 950, y2: 933 },
      { name: "Rice again", x1: 705, y1: 540, x2: 950, y2: 930 },
    ]);
    expect(boxes).toHaveLength(1);
  });
  test("more than 16 boxes are capped at 16", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `P${i}`, x1: (i % 10) * 100, y1: Math.floor(i / 10) * 300, x2: (i % 10) * 100 + 90, y2: Math.floor(i / 10) * 300 + 290 }));
    expect(await run(many)).toHaveLength(16);
  });
  test("grid values that aren't numbers give no box", () => expect(fromGrid({ x1: Number.NaN, y1: 0, x2: 10, y2: 10 }, { width: 100, height: 100 })).toBeUndefined());
});

describe("Meta response bodies that aren't objects", () => {
  for (const body of ["null", "[]", "42", '"ok"']) {
    test(`${body} is a failed call, charged its worst case`, async () => {
      const client = new MetaClient({ apiKey: "k", guard, fetch: fakeMeta(() => new Response(body, { status: 200 })).fetch });
      await expect(client.responses({ jobId: "j", what: "t", maxUsd: 0.01 }, {}, () => 0)).rejects.toThrow("not a JSON object");
      expect(guard.spentToday()).toBeCloseTo(0.01, 12);
    });
  }
});

describe("Spark responses that aren't clean", () => {
  const call = { jobId: "j", what: "t", developer: "d", user: [], name: "n", schema: {}, maxOutputTokens: 100 };
  for (const [name, body] of [
    ["incomplete (ran out of tokens)", responseWithText("{}", { status: "incomplete" })],
    ["failed", responseWithText("{}", { status: "failed" })],
    ["no output", { status: "completed", output: [] }],
    ["output not JSON", responseWithText("Sure! Here are the products: ...")],
    ["only reasoning", { status: "completed", output: [{ type: "reasoning", content: [] }] }],
    ["null items in output", { status: "completed", output: [null, { type: "message", content: [null, 5] }] }],
  ] as const) {
    test(`${name} throws SparkError, never a made-up answer`, async () => {
      await expect(sparkJson(clientFor(body), call)).rejects.toBeInstanceOf(SparkError);
    });
  }
});

// QA round 1 on PR #5.
import { findProducts } from "../../src/pipeline/cutouts.ts";
import { MAX_INPUT_PIXELS } from "../../src/pipeline/photo.ts";
import { MetaApiError } from "../../src/meta/client.ts";
import sharp from "sharp";
import { describeCall } from "../../src/pipeline/test-stall.ts";
import type { FakeCall } from "../../src/meta/test-fakes.ts";

describe("QA round 1 on PR #5", () => {
  const W = 400;
  const H = 300;
  /** A fake Meta for findProducts: SAM answers from `sam` by phrase; Spark proposes `products`, reviews by `review`, boxes `missed`. */
  function stall(o: {
    products: { name: string; phrase_a: string; phrase_b: string }[];
    broad?: string;
    sam: Record<string, { box: { left: number; top: number; right: number; bottom: number }; c: number }[]>;
    boxes?: { box: { left: number; top: number; right: number; bottom: number }; c: number }[];
    missed?: { name: string; x1: number; y1: number; x2: number; y2: number }[];
    review?: (names: string[], developer: string) => { crop: number; sellable: boolean; name: string; same_as?: number }[];
    samFail?: string;
  }) {
    const samCalls: string[] = [];
    const meta = fakeMeta((c: FakeCall) => {
      const d = describeCall(c.body);
      if (d.model === "sam-3.1") {
        samCalls.push(d.prompt);
        if (d.prompt === o.samFail) return new Response('{"error":{"message":"boom"}}', { status: 400 });
        if (d.prompt.startsWith("<0f>")) return responseWithText(samText((o.boxes ?? []).map((b, i) => ({ ...b, id: i }))));
        return responseWithText(samText(o.sam[d.prompt] ?? []));
      }
      if (d.format === "stall_products") return responseWithText(JSON.stringify({ products: o.products, broad_phrase: o.broad ?? "" }));
      if (d.format === "crop_review") {
        const names = d.texts.map((t) => /suggested name: (.*)\):$/.exec(t)?.[1] ?? "");
        const verdicts = o.review ? o.review(names, d.developer) : names.map((n, i) => ({ crop: i + 1, sellable: true, name: n, same_as: 0 }));
        return responseWithText(JSON.stringify({ verdicts }));
      }
      if (d.format === "missed_products") return responseWithText(JSON.stringify({ missed: o.missed ?? [] }));
      throw new Error("unexpected call");
    });
    return { client: new MetaClient({ apiKey: "k", guard, fetch: meta.fetch }), samCalls, meta };
  }
  const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });

  test("a broad phrase returning a whole-table mask doesn't wipe out the products inside it", async () => {
    const f = stall({
      products: [
        { name: "Tomato paste", phrase_a: "tomato tin", phrase_b: "tomato can" },
        { name: "Peak milk", phrase_a: "milk tin", phrase_b: "milk can" },
      ],
      broad: "tin",
      sam: { "tomato tin": [{ box: TOMATO, c: 0.8 }], "milk tin": [{ box: MILK, c: 0.8 }], tin: [{ box: box(0, 0, W, H), c: 0.95 }] },
    });
    const cut = await findProducts(f.client, "j", photo);
    expect(cut.map((c) => c.name).sort()).toEqual(["Peak milk", "Tomato paste"]);
  });

  test("a missed-product box over the trader's shirt gives no cut-out", async () => {
    const shirt = box(150, 160, 80, 100);
    const f = stall({
      products: [{ name: "Ankara fabric", phrase_a: "fabric", phrase_b: "cloth" }],
      sam: { person: [{ box: box(130, 100, 120, 200), c: 0.95 }], fabric: [{ box: shirt, c: 0.9 }] },
      missed: [{ name: "Ankara fabric", x1: 375, y1: 533, x2: 575, y2: 866 }],
      boxes: [{ box: shirt, c: 0.9 }],
    });
    expect(await findProducts(f.client, "j", photo)).toEqual([]);
  });

  test("a heap of 500 tomatoes stays within the 60-call cap and gives the product", async () => {
    const heap = Array.from({ length: 500 }, (_, i) => ({ box: box(10 + (i % 25) * 15, 10 + Math.floor(i / 25) * 14, 12, 12), c: 0.6 + (i % 10) / 100 }));
    const f = stall({ products: [{ name: "Tomatoes", phrase_a: "tomato", phrase_b: "red tomato" }], sam: { tomato: heap } });
    const cut = await findProducts(f.client, "j", photo);
    expect(cut.map((c) => c.name)).toEqual(["Tomatoes"]);
    expect(guard.callsForJob("j")).toBeLessThanOrEqual(10);
  });

  test("40 identical tins give one cut-out for that product", async () => {
    const tins = Array.from({ length: 40 }, (_, i) => ({ box: box(5 + (i % 10) * 39, 5 + Math.floor(i / 10) * 70, 30, 60), c: 0.7 + (i % 5) / 100 }));
    const f = stall({ products: [{ name: "Tomato paste", phrase_a: "tomato tin", phrase_b: "tomato can" }], sam: { "tomato tin": tins, "tomato can": tins } });
    const cut = await findProducts(f.client, "j", photo);
    expect(cut).toHaveLength(1);
    expect(cut[0]!.name).toBe("Tomato paste");
  });

  test("after a SAM call fails, no new SAM call starts", async () => {
    const products = Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, phrase_a: `item ${i} a`, phrase_b: `item ${i} b` }));
    const f = stall({ products, broad: "packet", sam: {}, samFail: "item 2 b" });
    await expect(findProducts(f.client, "j", photo)).rejects.toBeInstanceOf(MetaApiError);
    // Before the fix the other workers carried on through all 26 phrases after the job had
    // already failed. Now nothing new starts once the failure is caught.
    const atFailure = f.samCalls.length;
    await Bun.sleep(20);
    expect(f.samCalls.length).toBe(atFailure);
    expect(atFailure).toBeLessThan(26); // person + 24 product phrases + broad = 26 when nothing stops
  });

  test("an accepted broad-phrase crop with no name is dropped, not called \"Product\"", async () => {
    const f = stall({
      products: [],
      broad: "packet",
      sam: { packet: [{ box: TOMATO, c: 0.8 }] },
      review: (names) => names.map((_, i) => ({ crop: i + 1, sellable: true, name: "" })),
    });
    expect(await findProducts(f.client, "j", photo)).toEqual([]);
  });

  test("a JPEG with corrupt bytes is refused with the trader message", async () => {
    const good = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#c84" } })
      .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><circle cx="400" cy="300" r="200" fill="#123"/></svg>') }])
      .jpeg({ quality: 90 })
      .toBuffer();
    const bad = Buffer.from(good);
    for (let i = 600; i < bad.length - 2; i += 97) bad[i] = 0x5a;
    await expect(preparePhoto(new Uint8Array(bad))).rejects.toThrow("couldn't be opened");
    await expect(preparePhoto(new Uint8Array(good))).resolves.toBeDefined();
  });

  test("a photo over the pixel limit is told it's too large", async () => {
    // Only the header is read, so a small JPEG whose header claims the huge size is enough (encoding a real one took 5 s).
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 10;
    const huge = Buffer.from(await sharp({ create: { width: 16, height: 16, channels: 3, background: "#fff" } }).jpeg({ quality: 10 }).toBuffer());
    const sof = huge.indexOf(Buffer.from([0xff, 0xc0]));
    huge.writeUInt16BE(side, sof + 5); // height
    huge.writeUInt16BE(side, sof + 7); // width
    expect((await sharp(huge).metadata()).width).toBe(side);
    await expect(preparePhoto(new Uint8Array(huge))).rejects.toThrow("too large");
  });

  for (const orientation of [3, 6, 8]) {
    test(`EXIF orientation ${orientation}: the left half stays on the left in the prepared photo`, async () => {
      // Red on the left as the trader sees it: stored so that the orientation tag puts it there.
      const shown = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#00f" } })
        .composite([{ input: { create: { width: 200, height: 300, channels: 3, background: "#f00" } }, left: 0, top: 0 }])
        .png()
        .toBuffer();
      const undo = { 3: 180, 6: -90, 8: 90 }[orientation]!;
      const stored = await sharp(await sharp(shown).rotate(undo).toBuffer()).withMetadata({ orientation }).jpeg().toBuffer();
      const p = await preparePhoto(new Uint8Array(stored));
      expect([p.width, p.height]).toEqual([400, 300]);
      const { data } = await sharp(p.jpeg).raw().toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => data.subarray((y * p.width + x) * 3, (y * p.width + x) * 3 + 3);
      expect(at(50, 150)[0]!).toBeGreaterThan(200); // red on the left
      expect(at(350, 150)[2]!).toBeGreaterThan(200); // blue on the right
    });
  }
});

// QA round 2 on PR #5: other items of a kept product must not come back through the missed-products step.
describe("QA round 2 on PR #5", () => {
  const W = 400;
  const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });
  const tins = Array.from({ length: 40 }, (_, i) => ({ box: box(5 + (i % 10) * 39, 5 + Math.floor(i / 10) * 70, 30, 60), c: 0.7 + (i % 5) / 100 }));
  const toGridBox = (b: ReturnType<typeof box>) => ({ x1: Math.round((b.left / W) * 1000), y1: Math.round((b.top / 300) * 1000), x2: Math.round((b.right / W) * 1000), y2: Math.round((b.bottom / 300) * 1000) });

  function stall(review: (n: number, developer: string) => { crop: number; sellable: boolean; name: string; same_as?: number }[]) {
    const prompts: Record<string, string> = {};
    const meta = fakeMeta((c: FakeCall) => {
      const d = describeCall(c.body);
      if (d.model === "sam-3.1") {
        if (d.prompt.startsWith("<0f>")) return responseWithText(samText(tins.slice(1, 17).map((t, i) => ({ ...t, id: i }))));
        return responseWithText(samText(d.prompt === "tomato tin" || d.prompt === "tomato can" ? tins : []));
      }
      if (d.format === "stall_products") return responseWithText(JSON.stringify({ products: [{ name: "Tomato paste", phrase_a: "tomato tin", phrase_b: "tomato can" }], broad_phrase: "" }));
      if (d.format === "missed_products") {
        prompts.missed = d.developer;
        return responseWithText(JSON.stringify({ missed: tins.slice(1, 17).map((t) => ({ name: "Tomato tin", ...toGridBox(t.box) })) }));
      }
      if (d.format === "crop_review") {
        const n = d.texts.filter((t) => t.startsWith("Crop ")).length;
        if (d.developer.includes("already in the catalogue")) prompts.boxReview = d.developer;
        return responseWithText(JSON.stringify({ verdicts: review(n, d.developer) }));
      }
      throw new Error("unexpected call");
    });
    return { client: new MetaClient({ apiKey: "k", guard, fetch: meta.fetch }), prompts };
  }

  test("40 tins, with the missed step boxing 16 more of them, give exactly one cut-out", async () => {
    const f = stall((n, dev) => Array.from({ length: n }, (_, i) => ({ crop: i + 1, sellable: true, name: dev.includes("already in the catalogue") ? "Tomato tin" : "Tomato paste", same_as: dev.includes("already in the catalogue") ? 1 : 0 })));
    const cut = await findProducts(f.client, "j", photo);
    expect(cut.map((c) => c.name)).toEqual(["Tomato paste"]);
    expect(f.prompts.missed).toContain("every other item");
    expect(f.prompts.boxReview).toContain("1. Tomato paste");
  });

  test("if review misses the repeat (same_as 0), repeated box names still give at most one extra cut-out", async () => {
    const f = stall((n) => Array.from({ length: n }, (_, i) => ({ crop: i + 1, sellable: true, name: "Tomato tin", same_as: 0 })));
    const cut = await findProducts(f.client, "j", photo);
    expect(cut.length).toBeLessThanOrEqual(2);
  });

  test("a box verdict with no same_as is treated as a repeat and dropped", async () => {
    const f = stall((n, dev) => Array.from({ length: n }, (_, i) => ({ crop: i + 1, sellable: true, name: dev.includes("already in the catalogue") ? "Sardines" : "Tomato paste" })));
    const cut = await findProducts(f.client, "j", photo);
    expect(cut.map((c) => c.name)).toEqual(["Tomato paste"]);
  });
});
