// Messy-input suite: prices and tool calls that must never become a published price.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../../src/meta/client.ts";
import { priceItems } from "../../src/pipeline/pricing.ts";
import { readSpoken } from "../../src/pipeline/quotes.ts";
import { scriptedSpark, setPrice, type ScriptedCall } from "../../src/pipeline/test-spark.ts";
import { SpendGuard } from "../../src/spend-guard.ts";

let dir: string;
let guard: SpendGuard;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pricing-messy-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const items = [
  { item: 1, name: "Rice" },
  { item: 2, name: "Garri" },
];

/** Runs one scripted call; returns whether it was accepted and the final line for item 1. */
async function one(call: ScriptedCall, said: string) {
  const spark = scriptedSpark([[call], "done"]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "j", items, [said]);
  return { accepted: r.events[0]!.accepted, line: r.lines[0]! };
}

describe("refused, so the trader is asked instead", () => {
  const cases: [string, ScriptedCall, string][] = [
    ["letter O for zero", setPrice(1, 600, "paint bucket", "rice na 6OO"), "rice na 6OO"],
    ["letter O inside a number", setPrice(1, 6000, "bag", "rice na 6O00"), "rice na 6O00"],
    ["letter l for one", setPrice(1, 1500, "bag", "rice na l500"), "rice na l500"],
    ["letter S for five", setPrice(1, 500, "bag", "rice na S00"), "rice na S00"],
    ["kobo", setPrice(1, 650, "bag", "rice na 650.50"), "rice na 650.50"],
    ["N/A as the price", { name: "set_price", args: { item: 1, price_naira: "N/A", unit: "bag", quote: "rice na N/A" } }, "rice na N/A"],
    ["price as text digits", { name: "set_price", args: { item: 1, price_naira: "6000", unit: "bag", quote: "rice na 6000" } }, "rice na 6000"],
    ["negative", setPrice(1, -6000, "bag", "rice na 6000"), "rice na 6000"],
    ["zero", setPrice(1, 0, "bag", "rice na 0"), "rice na 0"],
    ["under 10 naira", setPrice(1, 5, "bag", "rice na 5"), "rice na 5"],
    ["over 5 million", setPrice(1, 6_000_000, "bag", "rice na 6000000"), "rice na 6000000"],
    ["fraction", setPrice(1, 650.5, "bag", "rice na 650.5"), "rice na 650.5"],
    ["a range picked as one price", setPrice(1, 2000, "bag", "rice na two to two-five"), "rice na two to two-five"],
    ["a digit range picked as one price", setPrice(1, 2000, "bag", "rice na 2000 to 2500"), "rice na 2000 to 2500"],
    ["one of two prices", setPrice(1, 3000, "bag", "rice na 3k or 3,500"), "rice na 3k or 3,500"],
    ["Pidgin abi between prices", setPrice(1, 3000, "bag", "rice na 3k abi 3,500"), "rice na 3k abi 3,500"],
    ["unknown unit", setPrice(1, 6000, "per bag", "rice na 6000"), "rice na 6000"],
    ["empty quote", setPrice(1, 6000, "bag", ""), "rice na 6000"],
    ["one-letter quote", setPrice(1, 6000, "bag", "r"), "rice na 6000"],
    ["quote stitched from two places", setPrice(1, 6000, "bag", "rice na 6000"), "rice don finish. garri na 6000"],
    ["price from another item's quote, wrong number", setPrice(1, 7000, "bag", "garri na 6000"), "rice na 7k abeg. garri na 6000"],
    ["item 0", setPrice(0, 6000, "bag", "rice na 6000"), "rice na 6000"],
    ["item 3 (not on the list)", setPrice(3, 6000, "bag", "rice na 6000"), "rice na 6000"],
    ["item as text", { name: "set_price", args: { item: "1", price_naira: 6000, unit: "bag", quote: "rice na 6000" } }, "rice na 6000"],
    ["arguments not JSON", { name: "set_price", raw: "{item: 1, price 6000" }, "rice na 6000"],
    ["arguments null", { name: "set_price", raw: "null" }, "rice na 6000"],
    ["unknown tool", { name: "publish_catalogue", args: { item: 1 } }, "rice na 6000"],
  ];
  for (const [name, call, said] of cases) {
    test(name, async () => {
      const { accepted, line } = await one(call, said);
      expect(accepted).toBe(false);
      expect(line.price).toBeNull();
      expect(line.question).toBe("How much is Rice?");
    });
  }
});

describe("accepted, as the trader said it", () => {
  const cases: [string, ScriptedCall, string, number][] = [
    ["naira sign and commas", setPrice(1, 6000, "bag", "Rice na ₦6,000"), "Rice na ₦6,000 o", 6000],
    ["k shorthand", setPrice(1, 6000, "paint bucket", "rice na 6k for one paint"), "Rice na 6k for one paint.", 6000],
    ["1.8 meaning 1,800", setPrice(1, 1800, "bag", "na 1.8"), "Rice, na 1.8.", 1800],
    ["5-8 meaning 5,800", setPrice(1, 5800, "crate", "na 5-8"), "Rice crate na 5-8", 5800],
    ["words, no digits", setPrice(1, 200, "cup", "two hundred naira"), "rice, one cup, two hundred naira", 200],
    ["different case and punctuation", setPrice(1, 6000, "bag", "RICE NA 6000!"), "rice na 6000.", 6000],
    ["upper-case unit", setPrice(1, 6000, "Bag", "rice na 6000"), "rice na 6000", 6000],
  ];
  for (const [name, call, said, naira] of cases) {
    test(name, async () => {
      const { accepted, line } = await one(call, said);
      expect(accepted).toBe(true);
      expect(line.price?.naira).toBe(naira);
    });
  }
});

test("readSpoken reads every price in a range", () => {
  expect(readSpoken("2000 to 2500").prices.map((p) => p.value)).toEqual([2000, 2500]);
});

test("a duplicate of the same item in one turn: the last call wins", async () => {
  const spark = scriptedSpark([[setPrice(1, 3000, "bag", "rice na 3k"), setPrice(1, 3500, "bag", "no no 3,500")], "done"]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "j", items, ["rice na 3k... no no 3,500"]);
  expect(r.lines[0]!.price?.naira).toBe(3500);
});

test("a flag after a price means unsure: the trader is asked", async () => {
  const spark = scriptedSpark([[setPrice(1, 3000, "bag", "rice na 3k"), { name: "flag_missing_price", args: { item: 1, question: "Rice na 3k or 3,500?" } }], "done"]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "j", items, ["rice na 3k or 3,500"]);
  expect(r.lines[0]).toMatchObject({ price: null, question: "How much is Rice?" });
});

test("a blank question gets a plain default", async () => {
  const spark = scriptedSpark([[{ name: "flag_missing_price", args: { item: 2, question: "   " } }], "done"]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "j", items, ["rice na 3k"]);
  expect(r.lines[1]!.question).toBe("How much is Garri?");
});

// QA round 1 on PR #6: the answer key from the QA comment, every row.
describe("QA round 1 on PR #6", () => {
  type Row = { said: string | string[]; calls: ScriptedCall[]; items?: { item: number; name: string }[]; expect: Record<number, number | null> };
  const RB = [
    { item: 1, name: "Rice" },
    { item: 2, name: "Beans" },
  ];
  async function run(row: Row) {
    const items = row.items ?? RB;
    const spark = scriptedSpark([row.calls, "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "qa6", items, Array.isArray(row.said) ? row.said : [row.said]);
    for (const [item, naira] of Object.entries(row.expect)) {
      const line = r.lines.find((l) => l.item === Number(item))!;
      if (naira === null) expect(line).toMatchObject({ price: null, question: `How much is ${line.name}?` });
      else expect(line.price?.naira).toBe(naira);
    }
    expect(guard.callsForJob("qa6")).toBeLessThanOrEqual(4);
    // Every Spark turn is one ledger entry; the loop stops early once every item is decided.
    expect(guard.callsForJob("qa6")).toBe(spark.calls.length);
    expect(["all-done", "model-finished"]).toContain(r.stopped);
    return r;
  }

  const refused: [string, Row][] = [
    ["no price said, quote is just the name", { said: "rice dey, beans dey", calls: [setPrice(1, 5000, "bag", "rice")], expect: { 1: null } }],
    ["N/A", { said: "rice na N/A", calls: [setPrice(1, 4000, "bag", "rice na N/A")], expect: { 1: null } }],
    ["same as before", { said: "rice same as before", calls: [setPrice(1, 3000, "bag", "same as before")], expect: { 1: null } }],
    ["free", { said: "rice na free", calls: [setPrice(1, 500, "bag", "rice na free")], expect: { 1: null } }],
    ["two tousand read as 20,000", { said: "rice na two tousand", calls: [setPrice(1, 20000, "bag", "rice na two tousand")], expect: { 1: null } }],
    [
      "Pidgin with no prices at all",
      { said: "abeg buy my rice, my beans e sweet well well", calls: [setPrice(1, 2500, "bag", "abeg buy"), setPrice(2, 1800, "cup", "e sweet well well")], expect: { 1: null, 2: null } },
    ],
    ["3000 cut out of 30000", { said: "rice na 30000", calls: [setPrice(1, 3000, "bag", "rice na 3000")], expect: { 1: null } }],
    ["500 cut out of 1500", { said: "beans na 1500 per cup", calls: [setPrice(2, 500, "cup", "500")], expect: { 2: null } }],
    ["650 read as 650,000", { said: "rice na 650", calls: [setPrice(1, 650000, "bag", "rice na 650")], expect: { 1: null } }],
    ["1,5OO as 15,000", { said: "rice na 1,5OO", calls: [setPrice(1, 15000, "bag", "rice na 1,5OO")], expect: { 1: null } }],
    ["1,5OO as 1,500", { said: "rice na 1,5OO", calls: [setPrice(1, 1500, "bag", "rice na 1,5OO")], expect: { 1: null } }],
    ["1000-1200", { said: "rice na 1000-1200", calls: [setPrice(1, 1000, "bag", "rice na 1000-1200")], expect: { 1: null } }],
    ["2k/2.5k", { said: "rice 2k/2.5k", calls: [setPrice(1, 2500, "bag", "rice 2k/2.5k")], expect: { 1: null } }],
    ["a partial quote cut out of a range", { said: "rice na 1000 to 1200", calls: [setPrice(1, 1000, "bag", "rice na 1000")], expect: { 1: null } }],
    ["the price before a correction", { said: "rice na 3000... no, 3500", calls: [setPrice(1, 3000, "bag", "rice na 3000")], expect: { 1: null } }],
    ["a correction in a later voice note", { said: ["rice na 3000", "sorry rice na 3500 now"], calls: [setPrice(1, 3000, "bag", "rice na 3000")], expect: { 1: null } }],
    ["two prices in one quote", { said: "rice 500 each, 2000 for five", calls: [setPrice(1, 2000, "piece", "rice 500 each, 2000 for five")], expect: { 1: null } }],
    ["one of two prices quoted alone", { said: "rice 500 each, 2000 for five", calls: [setPrice(1, 2000, "piece", "2000 for five")], expect: { 1: null } }],
    ["Rice's quote used for Beans", { said: "rice na 3000", calls: [setPrice(1, 3000, "bag", "rice na 3000"), setPrice(2, 3000, "bag", "rice na 3000")], expect: { 1: 3000, 2: null } }],
    ["all the tins for a bag of rice", { said: "all the tins 800, rice dey", calls: [setPrice(1, 800, "bag", "all the tins 800")], expect: { 1: null } }],
    [
      "two items with the same name",
      {
        said: "tomato 800, the big tomato na 1200",
        items: [
          { item: 1, name: "Tomato" },
          { item: 2, name: "Tomato" },
        ],
        calls: [setPrice(1, 800, "piece", "tomato 800"), setPrice(2, 800, "piece", "tomato 800")],
        expect: { 1: null, 2: null },
      },
    ],
    ["a leading question from the model", { said: "rice na 3000", calls: [{ name: "flag_missing_price", args: { item: 2, question: "Is beans 2000 naira?" } }], expect: { 2: null } }],
    [
      "an assistant-style question from the model",
      { said: "rice na 3000", calls: [{ name: "flag_missing_price", args: { item: 2, question: "As an AI assistant I cannot determine the price" } }], expect: { 2: null } },
    ],
  ];
  for (const [name, row] of refused) test(`refused and asked: ${name}`, async () => void (await run(row)));

  const accepted: [string, Row][] = [
    ["the corrected price", { said: "rice na 3000... no, 3500", calls: [setPrice(1, 3500, "bag", "no, 3500")], expect: { 1: 3500 } }],
    ["1.500 is 1,500", { said: "rice na 1.500", calls: [setPrice(1, 1500, "bag", "rice na 1.500")], expect: { 1: 1500 } }],
    ["1.8 is 1,800", { said: "rice na 1.8", calls: [setPrice(1, 1800, "bag", "rice na 1.8")], expect: { 1: 1800 } }],
    ["3k is 3,000", { said: "rice na 3k", calls: [setPrice(1, 3000, "bag", "rice na 3k")], expect: { 1: 3000 } }],
    [
      "all the tins 800 for two tins",
      {
        said: "all the tins 800",
        items: [
          { item: 1, name: "Tomato tin" },
          { item: 2, name: "Milk tin" },
        ],
        calls: [setPrice(1, 800, "tin", "all the tins 800"), setPrice(2, 800, "tin", "all the tins 800")],
        expect: { 1: 800, 2: 800 },
      },
    ],
    ["two items, two prices, one message", { said: "rice na 3000, beans na 1500", calls: [setPrice(1, 3000, "bag", "rice na 3000"), setPrice(2, 1500, "cup", "beans na 1500")], expect: { 1: 3000, 2: 1500 } }],
    ["a price in words", { said: "rice na two thousand five hundred", calls: [setPrice(1, 2500, "bag", "rice na two thousand five hundred")], expect: { 1: 2500 } }],
  ];
  for (const [name, row] of accepted) test(`accepted: ${name}`, async () => void (await run(row)));

  test("the question always comes from code, never the model", async () => {
    const r = await run({ said: "rice na 3000", calls: [{ name: "flag_missing_price", args: { item: 2, question: "How much?" } }], expect: { 2: null } });
    expect(r.lines[1]!.question).toBe("How much is Beans?");
  });
});
