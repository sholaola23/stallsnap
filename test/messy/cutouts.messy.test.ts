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
