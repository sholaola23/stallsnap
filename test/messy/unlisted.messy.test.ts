// Messy-input suite: a price for an item that isn't in the photo. The trader is told
// "You mentioned yam, send a photo of it", in their own words, and nothing is priced from it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../../src/meta/client.ts";
import { MAX_UNLISTED, priceItems } from "../../src/pipeline/pricing.ts";
import { scriptedSpark, setPrice } from "../../src/pipeline/test-spark.ts";
import { SpendGuard } from "../../src/spend-guard.ts";

let dir: string;
let guard: SpendGuard;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unlisted-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const items = [
  { item: 1, name: "Rice" },
  { item: 2, name: "Garri" },
];
const note = (name: string, quote: string) => ({ name: "note_unlisted_item", args: { name, quote } });

async function run(said: string, calls: ReturnType<typeof note>[]) {
  const spark = scriptedSpark([[setPrice(1, 1500, "piece", "rice na 1500"), ...calls], "done"]);
  return priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "u", items, [said]);
}

describe("accepted: the trader's own words for an item not in the photo", () => {
  test("\"yam na 2000\" is noted as yam, and no listed item gets ₦2,000", async () => {
    const r = await run("rice na 1500, yam na 2000", [note("yam", "yam na 2000")]);
    expect(r.unlisted).toEqual(["yam"]);
    expect(r.lines.map((l) => l.price?.naira ?? null)).toEqual([1500, null]);
  });
  test("the name is sent back as the trader said it, in lower case", async () => {
    const r = await run("rice na 1500. Sweet Potato na 800", [note("Sweet Potato", "Sweet Potato na 800")]);
    expect(r.unlisted).toEqual(["sweet potato"]);
  });
  test("the same item noted twice is mentioned once", async () => {
    const r = await run("rice na 1500, yam na 2000", [note("yam", "yam na 2000"), note("Yam", "yam na 2000")]);
    expect(r.unlisted).toEqual(["yam"]);
  });
  test(`at most ${MAX_UNLISTED} items are mentioned`, async () => {
    const said = "rice na 1500, yam na 2000, egusi na 900, ogbono na 700, crayfish na 500";
    const r = await run(said, [note("yam", "yam na 2000"), note("egusi", "egusi na 900"), note("ogbono", "ogbono na 700"), note("crayfish", "crayfish na 500")]);
    expect(r.unlisted).toEqual(["yam", "egusi", "ogbono"]);
  });
});

describe("refused: the model's own words or a listed item never reach the trader", () => {
  const cases: [string, string, string, string][] = [
    ["a name that isn't in the quote", "rice na 1500, yam na 2000", "yam tubers", "yam na 2000"],
    ["a quote that isn't in the transcript", "rice na 1500", "yam", "yam na 2000"],
    ["a quote with no price in it", "rice na 1500, I get yam too", "yam", "I get yam too"],
    ["a listed item", "rice na 1500, garri na 900", "garri", "garri na 900"],
    ["a name with a number", "rice na 1500, yam na 2000", "yam 2000", "yam na 2000"],
    ["a name longer than four words", "rice na 1500, big fresh new yam tuber na 2000", "big fresh new yam tuber", "big fresh new yam tuber na 2000"],
    ["an empty name", "rice na 1500, yam na 2000", " ", "yam na 2000"],
  ];
  for (const [what, said, name, quote] of cases) {
    test(what, async () => {
      const r = await run(said, [note(name, quote)]);
      expect(r.unlisted).toEqual([]);
      const ev = r.events.find((e) => e.name === "note_unlisted_item")!;
      expect(ev.accepted).toBe(false);
    });
  }
});

describe("a noted name can't be used to cut a listed item's price short", () => {
  const cases: [string, string, string][] = [
    ["rice na 1500 abeg 2000", "abeg", "abeg 2000"],
    ["rice na 1500 sorry 2000", "sorry", "sorry 2000"],
    ["rice na 1500 no 2000", "no", "no 2000"],
    ["rice na 1500 per bag 2000", "bag", "bag 2000"],
    ["rice na 1500 to 2000", "to", "to 2000"],
    ["rice na 1500 yam", "yam", "rice na 1500 yam"],
  ];
  for (const [said, name, quote] of cases) {
    test(`${JSON.stringify(said)}: "${name}" is refused, and Rice is asked`, async () => {
      const r = await run(said, [note(name, quote)]);
      expect(r.unlisted).toEqual([]);
      expect(r.lines[0]!.price).toBeNull();
    });
  }
  test("without a note, \"rice na 1500, yam na 2000\" asks Rice rather than guess where its price ends", async () => {
    const r = await run("rice na 1500, yam na 2000", []);
    expect(r.lines[0]!.price).toBeNull();
  });
});
