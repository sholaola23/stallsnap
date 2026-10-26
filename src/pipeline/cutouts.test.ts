import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { MetaClient } from "../meta/client.ts";
import { fakeMeta, type FakeCall } from "../meta/test-fakes.ts";
import { SpendGuard } from "../spend-guard.ts";
import { cutoutPng, findProducts } from "./cutouts.ts";
import type { Photo } from "./photo.ts";
import { segmentBoxes } from "./sam.ts";
import { BAG_ON_PERSON, MILK, PERSON, RICE, TOMATO, describeCall, responseWithText, samText, stallPhoto } from "./test-stall.ts";

let dir: string;
let guard: SpendGuard;
let photo: Photo;
beforeAll(async () => {
  photo = await stallPhoto();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cutouts-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A believable run: Spark proposes tomato tins and milk tins (rice is missed),
// SAM finds them, the person, and a bag on the person; review rejects a
// stray crop; Spark then boxes the missed rice.
function stallMeta(overrides: Partial<Record<string, (c: FakeCall) => unknown>> = {}) {
  return fakeMeta((c) => {
    const d = describeCall(c.body);
    if (d.model === "sam-3.1") {
      const sam: Record<string, string> = {
        person: samText([{ box: PERSON, c: 0.95 }]),
        "tomato tin": samText([{ box: TOMATO, c: 0.9 }]),
        "tomato can": samText([{ box: TOMATO, c: 0.85 }]), // same tin again: deduped
        "milk tin": samText([{ box: MILK, c: 0.88 }]),
        "evaporated milk": samText([{ box: MILK, c: 0.4 }]), // below 0.5: dropped
        tin: samText([{ box: BAG_ON_PERSON, c: 0.7 }, { box: { left: 300, top: 10, right: 330, bottom: 30 }, c: 0.6 }]),
      };
      if (d.prompt.startsWith("<0f>")) return responseWithText(samText([{ box: RICE, c: 0.8, id: 0 }]));
      return responseWithText(sam[d.prompt] ?? "");
    }
    const o = overrides[d.format ?? ""];
    if (o) return o(c);
    if (d.format === "stall_products") {
      return responseWithText(
        JSON.stringify({
          products: [
            { name: "Tomato paste", phrase_a: "tomato tin", phrase_b: "tomato can" },
            { name: "Peak milk", phrase_a: "milk tin", phrase_b: "evaporated milk" },
          ],
          broad_phrase: "tin",
        }),
      );
    }
    if (d.format === "crop_review") {
      const names = d.texts.map((t) => /suggested name: (.*)\):$/.exec(t)?.[1] ?? "");
      return responseWithText(
        JSON.stringify({
          verdicts: names.map((n, i) => ({ crop: i + 1, sellable: n !== "Product", name: n === "Product" ? "" : n })),
        }),
      );
    }
    if (d.format === "missed_products") {
      return responseWithText(JSON.stringify({ missed: [{ name: "Rice bag", x1: 700, y1: 533, x2: 950, y2: 933 }] }));
    }
    throw new Error(`unexpected call ${d.model} ${d.format}`);
  });
}

describe("findProducts", () => {
  test("finds each product once, drops people and junk, and recovers a missed product from a box", async () => {
    const meta = stallMeta();
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch });
    const cutouts = await findProducts(client, "job1", photo);

    expect(cutouts.map((c) => [c.name, c.source, c.mask.left, c.mask.top])).toEqual([
      ["Tomato paste", "phrase", TOMATO.left, TOMATO.top],
      ["Peak milk", "phrase", MILK.left, MILK.top],
      ["Rice bag", "box", RICE.left, RICE.top],
    ]);

    // 1 propose + SAM for person and 5 phrases + 1 review + 1 missed + 1 SAM boxes
    expect(meta.calls).toHaveLength(10);
    expect(guard.callsForJob("job1")).toBe(10);
    expect(guard.spentToday()).toBeGreaterThan(0);
  });

  test("the bag on the person never reaches review", async () => {
    const reviewed: string[] = [];
    const meta = stallMeta({
      crop_review: (c) => {
        const d = describeCall(c.body);
        reviewed.push(...d.texts);
        return responseWithText(JSON.stringify({ verdicts: d.texts.map((_, i) => ({ crop: i + 1, sellable: true, name: "" })) }));
      },
    });
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch });
    const cutouts = await findProducts(client, "job1", photo);
    // Reviewed: tomato, milk, and the stray "tin" crop. Not the bag on the person.
    expect(reviewed).toHaveLength(3);
    expect(cutouts.some((c) => c.mask.left === BAG_ON_PERSON.left && c.mask.top === BAG_ON_PERSON.top)).toBe(false);
  });

  test("a stall with nothing for sale gives no cut-outs, not invented ones", async () => {
    const meta = stallMeta({
      stall_products: () => responseWithText(JSON.stringify({ products: [], broad_phrase: "" })),
      missed_products: () => responseWithText(JSON.stringify({ missed: [] })),
    });
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch });
    expect(await findProducts(client, "job1", photo)).toEqual([]);
  });

  test("the Spark requests follow Meta's rules", async () => {
    const meta = stallMeta();
    await findProducts(new MetaClient({ apiKey: "k", guard, fetch: meta.fetch }), "job1", photo);
    for (const c of meta.calls.filter((x) => (x.body as { model: string }).model === "muse-spark-1.3")) {
      const b = c.body as Record<string, any>;
      expect(b.store).toBe(false);
      expect(b.temperature).toBeUndefined();
      expect(b.top_p).toBeUndefined();
      expect(b.input[0].role).toBe("developer");
      expect(b.input[0].content.some((p: { type: string }) => p.type === "input_image")).toBe(false);
      expect(b.text.format).toMatchObject({ type: "json_schema", strict: true });
      expect(b.max_output_tokens).toBeGreaterThanOrEqual(6000);
    }
    for (const c of meta.calls.filter((x) => (x.body as { model: string }).model === "sam-3.1")) {
      expect((c.body as Record<string, any>).metadata).toEqual({ include_confidence: "true", mask_encoding: "one_bit" });
    }
  });
});

test("segmentBoxes sends pixel boxes with Meta's prompt builder", async () => {
  const meta = fakeMeta(() => responseWithText(""));
  await segmentBoxes(new MetaClient({ apiKey: "k", guard, fetch: meta.fetch }), "j", photo, [RICE]);
  expect(describeCall(meta.calls[0]!.body).prompt).toBe("<0f>0<|box;x1=280;y1=160;x2=379;y2=279;w=400;h=300|>");
  expect(() => segmentBoxes(new MetaClient({ apiKey: "k", guard, fetch: meta.fetch }), "j", photo, Array(17).fill(RICE))).toThrow("16");
});

test("cutoutPng keeps the trader's own pixels inside the mask and is transparent outside", async () => {
  const w = MILK.right - MILK.left;
  const h = MILK.bottom - MILK.top;
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) bits[y * w + x] = 1; // left half only
  const png = await cutoutPng(photo, { objectId: "0", left: MILK.left, top: MILK.top, width: w, height: h, bits, area: (w / 2) * h, confidence: 0.9 });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height, info.channels]).toEqual([w, h, 4]);
  const px = (x: number, y: number) => [...data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  const inside = px(5, 5);
  expect(inside[3]).toBe(255);
  expect(inside[2]!).toBeGreaterThan(200); // blue milk tin from the photo
  expect(inside[0]!).toBeLessThan(50);
  expect(px(w - 5, 5)[3]).toBe(0);
});
