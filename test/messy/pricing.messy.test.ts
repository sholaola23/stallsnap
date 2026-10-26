// Messy-input suite: prices and tool calls that must never become a published price.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../../src/meta/client.ts";
import { priceItems, quotePrices } from "../../src/pipeline/pricing.ts";
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
    ["5-8 meaning 5,800", setPrice(1, 5800, "crate", "na 5-8"), "Egg crate na 5-8", 5800],
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

test("quotePrices reads every number in a quote", () => {
  expect(quotePrices("2000 to 2500")).toEqual([2000, 2000000, 2500, 2500000]);
});

test("a duplicate of the same item in one turn: the last call wins", async () => {
  const spark = scriptedSpark([[setPrice(1, 3000, "bag", "rice na 3k"), setPrice(1, 3500, "bag", "no no 3,500")], "done"]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "j", items, ["rice na 3k... no no 3,500"]);
  expect(r.lines[0]!.price?.naira).toBe(3500);
});

test("a flag after a price means unsure: the trader is asked", async () => {
  const spark = scriptedSpark([[setPrice(1, 3000, "bag", "rice na 3k"), { name: "flag_missing_price", args: { item: 1, question: "Rice na 3k or 3,500?" } }], "done"]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "j", items, ["rice na 3k or 3,500"]);
  expect(r.lines[0]).toMatchObject({ price: null, question: "Rice na 3k or 3,500?" });
});

test("a blank question gets a plain default", async () => {
  const spark = scriptedSpark([[{ name: "flag_missing_price", args: { item: 2, question: "   " } }], "done"]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "j", items, ["rice na 3k"]);
  expect(r.lines[1]!.question).toBe("How much is Garri?");
});
