import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { JobLog } from "../joblog.ts";
import { MetaClient } from "../meta/client.ts";
import { fakeMeta } from "../meta/test-fakes.ts";
import { SpendGuard } from "../spend-guard.ts";
import { CLEANUP_PROMPT, cleanUp, cleanupStep } from "./cleanup.ts";

const W = 300;
const H = 200;
let cutout: Uint8Array;

/** A striped tin (left 60%) on transparency, like a real cut-out. */
async function makeCutout() {
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 20; y < 180; y++) for (let x = 30; x < 180; x++) rgba.set(y % 20 < 10 ? [190, 40, 40, 255] : [240, 220, 60, 255], (y * W + x) * 4);
  return new Uint8Array(await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer());
}

/** What Muse Image might send back: the cut-out on a background, optionally changed. */
async function edited(o: { brighten?: number; recolour?: boolean; addObject?: boolean; width?: number; height?: number } = {}) {
  let img = sharp(cutout).flatten({ background: "#fafafa" });
  if (o.brighten) img = img.linear(1, o.brighten);
  if (o.recolour) img = img.tint({ r: 30, g: 120, b: 220 });
  let buf = await img.png().toBuffer();
  if (o.addObject) buf = await sharp(buf).composite([{ input: { create: { width: 60, height: 60, channels: 3, background: "#204080" } }, left: 220, top: 120 }]).png().toBuffer();
  if (o.width) buf = await sharp(buf).resize({ width: o.width, height: o.height, fit: "fill" }).png().toBuffer();
  return { created: 1, data: [{ b64_json: buf.toString("base64") }], output_format: "png" };
}

let dir: string;
let guard: SpendGuard;
beforeAll(async () => {
  cutout = await makeCutout();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cleanup-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const client = (body: unknown | (() => unknown)) => {
  const meta = fakeMeta(() => (typeof body === "function" ? (body as () => unknown)() : body));
  return { meta, client: new MetaClient({ apiKey: "k", guard, fetch: meta.fetch }) };
};

describe("cleanUp", () => {
  test("a clean background with slightly better lighting is used", async () => {
    const { client: c } = client(await edited({ brighten: 8 }));
    const r = await cleanUp(c, "j", cutout);
    expect(r.cleaned).toBe(true);
    const meta = await sharp(r.png).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
    expect(guard.spentToday()).toBeCloseTo(0.01, 10);
  });

  test("a product whose colours changed falls back to the plain cut-out", async () => {
    const { client: c } = client(await edited({ recolour: true }));
    const r = await cleanUp(c, "j", cutout);
    expect(r).toMatchObject({ cleaned: false, reason: "product changed too much" });
    expect(r.png).toBe(cutout);
  });

  test("an object added to the background falls back to the plain cut-out", async () => {
    const { client: c } = client(await edited({ addObject: true }));
    expect(await cleanUp(c, "j", cutout)).toMatchObject({ cleaned: false, reason: "background not plain" });
  });

  test("an image of a different shape falls back", async () => {
    const { client: c } = client(await edited({ width: 300, height: 300 }));
    expect(await cleanUp(c, "j", cutout)).toMatchObject({ cleaned: false, reason: "returned image has a different shape" });
  });

  test("the same shape at another resolution is fine", async () => {
    const { client: c } = client(await edited({ width: 600, height: 400 }));
    expect((await cleanUp(c, "j", cutout)).cleaned).toBe(true);
  });

  test("an API error falls back, charged its worst case", async () => {
    const { client: c } = client(new Response('{"error":{"message":"safety"}}', { status: 400 }));
    const r = await cleanUp(c, "j", cutout);
    expect(r.cleaned).toBe(false);
    expect(guard.spentToday()).toBeCloseTo(0.01, 10);
  });

  // Grok review on PR #10: an answered call is always charged, so the ledger never under-counts.
  test("no image returned falls back and is still charged $0.01", async () => {
    const { client: c } = client({ created: 1, data: [] });
    expect(await cleanUp(c, "j", cutout)).toMatchObject({ cleaned: false, reason: "no image returned" });
    expect(guard.spentToday()).toBeCloseTo(0.01, 9);
  });

  test("the request turns off search and shell, sends no preservation fields, and names what must stay", async () => {
    const { meta, client: c } = client(await edited());
    await cleanUp(c, "j", cutout);
    const b = meta.calls[0]!.body as Record<string, any>;
    expect(meta.calls[0]!.url).toBe("https://api.meta.ai/v1/images/edits");
    expect(b).toMatchObject({ model: "muse-image-1.0", n: 1, size: `${W}x${H}`, output_format: "png", tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false } });
    for (const banned of ["mask", "input_fidelity", "seed"]) expect(b[banned]).toBeUndefined();
    expect(b.prompt).toBe(CLEANUP_PROMPT);
    expect(b.prompt).toContain("Keep the product exactly as it is");
    expect(b.prompt).toContain("including any wear");
    expect(b.images[0].image_url).toStartWith("data:image/png;base64,");
  });

  test("a tiny cut-out isn't sent at all", async () => {
    const tiny = new Uint8Array(await sharp({ create: { width: 30, height: 30, channels: 4, background: "#f00" } }).png().toBuffer());
    const { meta, client: c } = client({});
    expect((await cleanUp(c, "j", tiny)).cleaned).toBe(false);
    expect(meta.calls).toHaveLength(0);
  });
});

describe("cleanupStep", () => {
  test("each item is cleaned once per job, even if publishing runs again", async () => {
    const log = new JobLog(join(dir, "joblog.jsonl"));
    log.openJob("j");
    const file = join(dir, "item-1.png");
    writeFileSync(file, cutout);
    const { meta, client: c } = client(await edited({ brighten: 5 }));
    const step = cleanupStep(log, c, "j");
    const a = await step({ item: 1, file }, cutout);
    const b = await step({ item: 1, file }, cutout);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a).not.toEqual(cutout);
    expect(meta.calls).toHaveLength(1);
    log.close();
  });

  test("a clean-up a crash cut off gives the plain cut-out, never a failed catalogue, and isn't paid again", async () => {
    const first = new JobLog(join(dir, "joblog.jsonl"));
    first.openJob("j");
    void first.step("j", "cleanup:item-1", () => new Promise(() => {}));
    first.close();

    const log = new JobLog(join(dir, "joblog.jsonl"));
    const { meta, client: c } = client(await edited());
    const reasons: string[] = [];
    const png = await cleanupStep(log, c, "j", (_i, r) => reasons.push(r))({ item: 1, file: join(dir, "item-1.png") }, cutout);
    expect(png).toBe(cutout);
    expect(meta.calls).toHaveLength(0);
    expect(reasons[0]).toContain("interrupted");
    log.close();
  });
});
