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

test("readSpoken reads a range as no price, with both ends unreadable", () => {
  const r = readSpoken("2000 to 2500");
  expect(r.prices).toEqual([]);
  expect(r.unreadable).toEqual([0, 2]);
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

    ["two items, two prices, one message", { said: "rice na 3000, beans na 1500", calls: [setPrice(1, 3000, "bag", "rice na 3000"), setPrice(2, 1500, "cup", "beans na 1500")], expect: { 1: 3000, 2: 1500 } }],
    ["a price in words", { said: "rice na two thousand five hundred", calls: [setPrice(1, 2500, "bag", "rice na two thousand five hundred")], expect: { 1: 2500 } }],
  ];
  for (const [name, row] of accepted) test(`accepted: ${name}`, async () => void (await run(row)));

  test("the question always comes from code, never the model", async () => {
    const r = await run({ said: "rice na 3000", calls: [{ name: "flag_missing_price", args: { item: 2, question: "How much?" } }], expect: { 2: null } });
    expect(r.lines[1]!.question).toBe("How much is Beans?");
  });
});

// QA round 2 on PR #6.
describe("QA round 2 on PR #6", () => {
  async function priced(said: string, call: ScriptedCall) {
    const spark = scriptedSpark([[call], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "qa6r2", [{ item: 1, name: "Rice" }], [said]);
    return r.lines[0]!.price?.naira ?? null;
  }
  test("650.50 is not read as 650,500", async () => {
    expect(await priced("rice na 650.50", setPrice(1, 650500, "bag", "rice na 650.50"))).toBeNull();
  });
  test("\"abeg\" is not a correction: rice 1500 abeg 2000 is refused at 2000", async () => {
    expect(await priced("rice 1500 abeg 2000", setPrice(1, 2000, "bag", "abeg 2000"))).toBeNull();
  });
  test("still accepted: 1.8, 12.5 and 650.5k", async () => {
    expect(await priced("rice na 1.8", setPrice(1, 1800, "bag", "rice na 1.8"))).toBe(1800);
    expect(await priced("rice na 12.5", setPrice(1, 12500, "bag", "rice na 12.5"))).toBe(12500);
    expect(await priced("rice na 650.5k", setPrice(1, 650500, "bag", "rice na 650.5k"))).toBe(650500);
  });
  test("still accepted: a real correction with \"no\"", async () => {
    expect(await priced("rice na 1500, no, 2000", setPrice(1, 2000, "bag", "no, 2000"))).toBe(2000);
  });
});

// Grok review on PR #6: a range must never become one price; the item is asked instead.
describe("Grok review on PR #6: ranges", () => {
  async function priced(said: string, call: ScriptedCall) {
    const spark = scriptedSpark([[call], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "grok6", [{ item: 1, name: "Rice" }], [said]);
    return r.lines[0]!;
  }
  for (const [said, naira, quote] of [
    ["rice na 5-8 thousand", 5800, "rice na 5-8 thousand"],
    ["rice na 5-8 thousand", 8000, "8 thousand"],
    ["rice na 5-8k", 5800, "rice na 5-8k"],
    ["rice 5 to 8k", 8000, "8k"],
    ["rice 5 to 8k", 5000, "rice 5"],
    ["rice na 1,000-1,200", 1000, "rice na 1,000"],
    ["rice na 1,000-1,200", 1200, "1,200"],
    ["rice na 1000 - 1200", 1200, "1200"],
    ["rice two to three thousand", 3000, "three thousand"],
    ["rice na 2000 or 2500", 2500, "2500"],
  ] as const) {
    test(`${JSON.stringify(said)} quoted as ${JSON.stringify(quote)} at ${naira} is asked, not priced`, async () => {
      const line = await priced(said, setPrice(1, naira, "bag", quote));
      expect(line.price).toBeNull();
      expect(line.question).toBe("How much is Rice?");
    });
  }
  for (const [said, naira, quote] of [
    ["rice na 1-8", 1800, "rice na 1-8"],
    ["rice na 3k", 3000, "rice na 3k"],
    ["rice na two thousand five hundred", 2500, "rice na two thousand five hundred"],
  ] as const) {
    test(`still priced: ${JSON.stringify(said)} at ${naira}`, async () => {
      expect((await priced(said, setPrice(1, naira, "bag", quote))).price?.naira).toBe(naira);
    });
  }
});

// QA after Grok on PR #8 (B5): item names with a digit or size can be priced.
describe("names with a digit or size", () => {
  async function priced(names: string[], said: string, naira: number, quote: string) {
    const spark = scriptedSpark([[setPrice(1, naira, "piece", quote)], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "b5", names.map((name, i) => ({ item: i + 1, name })), [said]);
    return r.lines[0]!.price?.naira ?? null;
  }
  for (const [names, said] of [
    [["Peak Milk 400g", "Rice"], "peak milk na 1500"],
    [["Peak Milk 400g", "Rice"], "peak milk 400g na 1500"],
    [["Rice 50kg", "Beans"], "rice 50kg na 1500"],
    [["Rice 50kg", "Beans"], "rice na 1500"],
    [["7Up", "Coke"], "7up na 1500"],
    [["Milo 500g tin", "Bournvita"], "milo na 1500"],
  ] as const) {
    test(`${JSON.stringify(said)} prices ${names[0]} at 1,500`, async () => {
      expect(await priced([...names], said, 1500, said)).toBe(1500);
    });
  }
  for (const [names, said, naira] of [
    [["Coke 50cl", "Fanta"], "coke 50cl na 300", 300],
    [["Coke 50cl", "Fanta"], "coke na 300", 300],
    [["Milo 3-in-1", "Bournvita"], "milo 3-in-1 na 1500", 1500],
    [["Rice 50kg", "Beans"], "50kg rice na 45000", 45000],
    [["Rice 50kg", "Beans"], "rice 50kg 45k", 45000],
    [["7Up", "Coke"], "7up na 300", 300],
    [["Peak Milk 400g", "Rice"], "peak milk 400g na 1500", 1500],
  ] as const) {
    test(`${JSON.stringify(said)} prices ${names[0]} at ${naira}, never at the size`, async () => {
      expect(await priced([...names], said, naira, said)).toBe(naira);
    });
  }
  test("the size is never the price: 400 for Peak Milk 400g is refused", async () => {
    expect(await priced(["Peak Milk 400g", "Rice"], "peak milk 400g na 1500", 400, "peak milk 400g")).toBeNull();
  });
  test("\"2 7up 600\" is ambiguous (two for 600, or 600 each?) and is asked back", async () => {
    expect(await priced(["7Up", "Coke"], "2 7up 600", 600, "2 7up 600")).toBeNull();
    expect(await priced(["7Up", "Coke"], "2 7up 600", 600, "7up 600")).toBeNull();
    expect(await priced(["7Up", "Coke"], "2 7up 600", 300, "2 7up 600")).toBeNull();
  });
  test("a range is still never one price with a sized name", async () => {
    expect(await priced(["Rice 50kg", "Beans"], "rice 50kg 40 to 45k", 45000, "45k")).toBeNull();
  });
  test("two sizes of one product still need the size said", async () => {
    expect(await priced(["Peak Milk 400g", "Peak Milk 900g"], "peak milk na 1500", 1500, "peak milk na 1500")).toBeNull();
    expect(await priced(["Peak Milk 400g", "Peak Milk 900g"], "peak milk 400g na 1500", 1500, "peak milk 400g na 1500")).toBe(1500);
  });
  test("a size in a name is never read as the price", async () => {
    expect(await priced(["Rice 50kg", "Beans"], "rice 50kg", 50, "rice 50kg")).toBeNull();
  });
});

// QA round 3 on PR #6 and B6 on #8: name numbers count as names only where that item's whole name is said.
// A doubtful reading is asked about; a wrong price never goes through.
describe("bare numbers in item names", () => {
  async function priced(names: string[], said: string, naira: number, quote: string, item = 1) {
    const spark = scriptedSpark([[setPrice(item, naira, "piece", quote)], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "b6", names.map((name, i) => ({ item: i + 1, name })), [said]);
    return r.lines[item - 1]!.price?.naira ?? null;
  }
  const RICE_FIRST = (other: string) => ["Rice", other];
  for (const [other, said, naira, quote] of [
    ["5 Alive", "rice na 5 to 8k", 8000, "8k"],
    ["5 Alive", "rice na 5 to 8k", 8000, "rice na 5 to 8k"],
    ["Eggs 30", "rice na 30 to 35 thousand", 35000, "35 thousand"],
    ["Bread 500", "rice na 500 to 700", 700, "700"],
  ] as const) {
    test(`with ${other} listed, ${JSON.stringify(said)} is still a range and is asked`, async () => {
      expect(await priced(RICE_FIRST(other), said, naira, quote)).toBeNull();
    });
  }
  test("with 3 Crowns Milk listed, \"rice na 3 thousand\" is still ₦3,000", async () => {
    expect(await priced(["Rice", "3 Crowns Milk"], "rice na 3 thousand", 3000, "rice na 3 thousand")).toBe(3000);
  });
  for (const [names, said, naira, quote, item] of [
    [["Rice", "5 Alive"], "5 alive na 300", 300, "5 alive na 300", 2],
    [["Rice", "Eggs 30"], "eggs 30 na 1500", 1500, "eggs 30 na 1500", 2],
    [["Rice", "Bread 500"], "bread 500 na 700", 700, "bread 500 na 700", 2],
    [["Rice", "3 Crowns Milk"], "3 crowns milk na 400", 400, "3 crowns milk na 400", 2],
  ] as const) {
    test(`${JSON.stringify(said)} prices ${names[item - 1]} at ${naira}`, async () => {
      expect(await priced([...names], said, naira, quote, item)).toBe(naira);
    });
  }
  test("the number in a name is never the price: \"bread 500\" alone isn't ₦500", async () => {
    expect(await priced(["Rice", "Bread 500"], "bread 500", 500, "bread 500", 2)).toBeNull();
  });
  for (const [said, naira, quote] of [
    ["2 rice 6000", 6000, "2 rice 6000"],
    ["2 rice 6000", 6000, "rice 6000"],
    ["2 rice 6000", 3000, "rice 6000"],
    ["rice 2 bags 6000", 6000, "6000"],
    ["10 rice 6000", 6000, "rice 6000"],
  ] as const) {
    test(`a quantity with the item: ${JSON.stringify(said)} quoted ${JSON.stringify(quote)} at ${naira} is asked`, async () => {
      expect(await priced(["Rice", "Beans"], said, naira, quote)).toBeNull();
    });
  }
  test("another item's price straight before is not a quantity: \"rice na 3000 beans na 1500\"", async () => {
    expect(await priced(["Rice", "Beans"], "rice na 3000 beans na 1500", 1500, "beans na 1500", 2)).toBe(1500);
  });
});

// QA B8 on PR #8: a digit before "hundred" multiplies, like "thousand".
describe("digits with hundred", () => {
  for (const [said, value] of [["rice na 5 hundred", 500], ["rice na 2 hundred and 50", 250], ["rice na 2 hundred and fifty", 250], ["rice na 1 hundred", 100], ["rice na five hundred", 500]] as const) {
    test(`${JSON.stringify(said)} reads as ${value} and is priced`, async () => {
      expect(readSpoken(said).prices.map((p) => p.value)).toEqual([value]);
      const spark = scriptedSpark([[setPrice(1, value, "bag", said)], "done"]);
      const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "b8", [{ item: 1, name: "Rice" }], [said]);
      expect(r.lines[0]!.price?.naira).toBe(value);
    });
  }
  test("\"5 hundred\" is never read as 5", async () => {
    expect(readSpoken("rice na 5 hundred").prices.map((p) => p.value)).not.toContain(5);
  });
  test("a range with hundreds is still a range: \"5 to 6 hundred\"", () => {
    expect(readSpoken("rice na 5 to 6 hundred").prices).toEqual([]);
  });
});

// Allow-list grammar (coordinator, round 6): a price counts only in one plain shape; everything else is asked.
describe("allow-list grammar", () => {
  async function price(names: string[], said: string | string[], item: number, naira: number, quote: string) {
    const spark = scriptedSpark([[setPrice(item, naira, "piece", quote)], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "grammar", names.map((name, i) => ({ item: i + 1, name })), Array.isArray(said) ? said : [said]);
    return r.lines[item - 1]!.price?.naira ?? null;
  }
  // Digit and multiplier phrasing as a whole (B8 and the coordinator's list).
  for (const [said, naira] of [
    ["rice na 5 hundred", 500],
    ["rice na 5 hundred naira", 500],
    ["rice na 2 thousand", 2000],
    ["rice na 2 thousand 5 hundred", 2500],
    ["rice na 2k5", 2500],
    ["rice na 2.5k", 2500],
    ["rice na two thousand five hundred", 2500],
    ["rice na N500", 500],
    ["rice na ₦ 500", 500],
    ["rice na N 500", 500],
    ["rice 3000", 3000],
    ["rice is 3000 naira per bag", 3000],
    ["rice na 3000... no, 3500", 3500],
  ] as const) {
    test(`priced: ${JSON.stringify(said)} is ₦${naira}`, async () => {
      expect(await price(["Rice", "Beans"], said, 1, naira, said)).toBe(naira);
    });
  }
  test("a letter O inside a number stays refused: \"rice na 1,5OO\"", async () => {
    expect(await price(["Rice", "Beans"], "rice na 1,5OO", 1, 1500, "rice na 1,5OO")).toBeNull();
  });
  test("a list is split by item names: \"rice 3000 beans 3500\" prices both", async () => {
    expect(await price(["Rice", "Beans"], "rice 3000 beans 3500", 1, 3000, "rice 3000")).toBe(3000);
    expect(await price(["Rice", "Beans"], "rice 3000 beans 3500", 2, 3500, "beans 3500")).toBe(3500);
  });
  // QA round 4 on PR #6: shapes that must be asked back.
  for (const [names, said, item, naira, quote] of [
    [["Rice", "Eggs 30"], "eggs 30 to 35 thousand", 2, 35000, "35 thousand"],
    [["7Up", "Coke"], "two 7up 600", 1, 600, "7up 600"],
    [["Rice", "Beans"], "2 bags of rice 6000", 1, 6000, "rice 6000"],
    [["Peak Milk", "Rice"], "3 tins of peak milk 1500", 1, 1500, "peak milk 1500"],
    [["Rice", "5 Alive"], "2 5 alive 1400", 2, 1400, "5 alive 1400"],
    [["Rice", "Bread N500"], "rice n500 to n700", 1, 700, "n700"],
    [["Rice", "Biscuit 2k"], "rice 2k to 3k", 1, 3000, "3k"],
    [["Rice", "Beans"], "rice 500 each", 1, 500, "rice 500 each"],
    [["Rice", "Beans"], "rice for two 1000", 1, 1000, "rice for two 1000"],
    [["Rice", "Beans"], "rice 500, 2000 for five", 1, 2000, "2000 for five"],
    [["Rice", "Beans"], "rice na 5 to 6 hundred", 1, 600, "6 hundred"],
  ] as const) {
    test(`asked: ${JSON.stringify(said)} at ${naira}`, async () => {
      expect(await price([...names], said, item, naira, quote)).toBeNull();
    });
  }
  test("a price-shaped name is a name only where the item is said: \"bread n500 na 700\", \"biscuit 2k na 300\"", async () => {
    expect(await price(["Rice", "Bread N500"], "bread n500 na 700", 2, 700, "bread n500 na 700")).toBe(700);
    expect(await price(["Rice", "Biscuit 2k"], "biscuit 2k na 300", 2, 300, "biscuit 2k na 300")).toBe(300);
    expect(await price(["Rice", "Bread N500"], "bread n500", 2, 500, "bread n500")).toBeNull();
  });
  test("the latest message decides: a later unclear price for the item asks again", async () => {
    expect(await price(["Rice", "Beans"], ["rice na 3000", "rice na 3000 to 3500"], 1, 3000, "rice na 3000")).toBeNull();
  });
});

// Changed with the allow-list grammar (reported to the coordinator): a group price names no item,
// so "all the tins 800" used to price both tins and is now asked for each.
test("\"all the tins 800\" is asked for each tin, since it names no item", async () => {
  const spark = scriptedSpark([[setPrice(1, 800, "tin", "all the tins 800"), setPrice(2, 800, "tin", "all the tins 800")], "done"]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "tins", [{ item: 1, name: "Tomato tin" }, { item: 2, name: "Milk tin" }], ["all the tins 800"]);
  expect(r.lines.map((l) => l.price)).toEqual([null, null]);
});

// QA B9 and B10 on #8: a price expression is parsed as a whole; if it can't be read exactly, ask.
describe("whole price expressions", () => {
  async function price(said: string, naira: number) {
    const spark = scriptedSpark([[setPrice(1, naira, "piece", said)], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "chain", [{ item: 1, name: "Generator" }, { item: 2, name: "Rice" }], [said]);
    return r.lines[0]!.price?.naira ?? null;
  }
  for (const [said, naira] of [
    ["generator na 5 hundred thousand", 500000],
    ["generator na 2 hundred thousand", 200000],
    ["generator na five hundred thousand", 500000],
    ["generator na 3 thousand 5 hundred", 3500],
    ["generator na 3k 5 hundred", 3500],
    ["generator na 2 thousand 5 hundred naira", 2500],
    ["generator na three thousand five hundred", 3500],
    ["generator na 1 million", 1000000],
    ["generator na 2 hundred and 50", 250],
  ] as const) {
    test(`${JSON.stringify(said)} is ₦${naira.toLocaleString("en-GB")}`, async () => {
      expect(await price(said, naira)).toBe(naira);
    });
  }
  for (const [said, wrong] of [
    ["generator na 5 hundred thousand", 500],
    ["generator na 2 hundred thousand", 200],
    ["generator na 3 thousand 5 hundred", 3000],
  ] as const) {
    test(`${JSON.stringify(said)} is never ₦${wrong}`, async () => {
      expect(await price(said, wrong)).toBeNull();
    });
  }
  for (const said of ["generator na 1.5 hundred", "generator na 3000 500", "generator na 5 hundred 3 thousand 7"]) {
    test(`${JSON.stringify(said)} can't be read exactly, so it is asked`, async () => {
      expect(await price(said, 1500)).toBeNull();
      expect(await price(said, 3000)).toBeNull();
    });
  }
});

// QA B11 and B12 on #8: joiners between items, and selling words before a price.
describe("joiners and selling words", () => {
  async function price(said: string, item: number, naira: number, quote: string) {
    const spark = scriptedSpark([[setPrice(item, naira, "piece", quote)], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "b11", [{ item: 1, name: "Rice" }, { item: 2, name: "Garri" }], [said]);
    return r.lines[item - 1]!.price?.naira ?? null;
  }
  for (const joiner of ["and", "then", "plus", "but", "while"]) {
    test(`"rice na 1500 ${joiner} garri na 900" prices both`, async () => {
      const said = `rice na 1500 ${joiner} garri na 900`;
      expect(await price(said, 1, 1500, "rice na 1500")).toBe(1500);
      expect(await price(said, 2, 900, "garri na 900")).toBe(900);
    });
  }
  for (const said of ["rice go for 1500", "rice dey go for 1500", "rice we dey sell for 1500", "rice na for 1500", "rice i dey sell 1500"]) {
    test(`${JSON.stringify(said)} is ₦1,500`, async () => {
      expect(await price(said, 1, 1500, said)).toBe(1500);
    });
  }
  test("a joiner with a number after it is not a joiner: \"rice na 1500 and 50\" is asked", async () => {
    expect(await price("rice na 1500 and 50", 1, 1500, "rice na 1500")).toBeNull();
    expect(await price("rice na 1500 and 50", 1, 1550, "rice na 1500 and 50")).toBeNull();
  });
  test("a joiner at the end with no next item is not allowed: \"rice na 1500 but\" is asked", async () => {
    expect(await price("rice na 1500 but", 1, 1500, "rice na 1500")).toBeNull();
  });
  test("\"rice go for two 1000\" is still a quantity and is asked", async () => {
    expect(await price("rice go for two 1000", 1, 1000, "rice go for two 1000")).toBeNull();
  });
});

describe("neighbouring items: a price or quantity next to a name", () => {
  async function price(names: string[], said: string, item: number, naira: number, quote: string) {
    const spark = scriptedSpark([[setPrice(item, naira, "piece", quote)], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "nb", names.map((name, i) => ({ item: i + 1, name })), [said]);
    return r.lines[item - 1]!.price?.naira ?? null;
  }
  const RB = ["Rice", "Beans"];
  const asked: [string[], string, number, number, string][] = [
    [["Rice", "Beans", "Garri"], "rice, beans, garri. 3000 beans, 1500 garri", 3, 3000, "garri 3000"],
    [["Rice", "Beans", "Garri"], "rice, beans, garri. 3000 beans, 1500 garri", 2, 1500, "beans 1500"],
    [["Rice", "Beans", "Garri"], "rice, beans, garri. 3000 beans, 1500 garri", 1, 3000, "3000"],
    [RB, "rice dey, 3000 beans", 1, 3000, "rice dey 3000"],
    [RB, "rice dey, 3000 beans", 1, 3000, "3000"],
    [RB, "rice 3000, 2 beans 3500", 2, 3500, "beans 3500"],
    [RB, "rice na 3000 and two beans na 3500", 2, 3500, "beans na 3500"],
    [RB, "rice na 3000, 2 bags of beans 7000", 2, 7000, "beans 7000"],
    [RB, "rice dey, 2 bags of beans 7000", 2, 7000, "beans 7000"],
    [RB, "rice and beans na 3000", 2, 3000, "beans na 3000"],
    [RB, "rice and beans na 3000", 1, 3000, "3000"],
    [RB, "rice, beans na 3000", 2, 3000, "beans na 3000"],
    [RB, "rice, beans na 3000", 1, 3000, "3000"],
    [["Beans", "Eggs 30"], "beans na 1500 or 30", 1, 1500, "beans na 1500"],
    [["Bread 500"], "bread 500 na 500 or 700", 1, 700, "700"],
  ];
  for (const [names, said, item, naira, quote] of asked) {
    test(`${JSON.stringify(said)}: ${names[item - 1]} at ${naira} is asked`, async () => {
      expect(await price(names, said, item, naira, quote)).toBeNull();
    });
  }
  const priced: [string[], string, number, number, string][] = [
    [RB, "rice 3000, 2 beans 3500", 1, 3000, "rice 3000"],
    [RB, "rice 3000 beans 3500", 1, 3000, "rice 3000"],
    [RB, "rice 3000 beans 3500", 2, 3500, "beans 3500"],
    [["5 Alive", "3 Crowns Milk"], "5 alive na 650, 3 crowns milk na 900", 1, 650, "5 alive na 650"],
    [["5 Alive", "3 Crowns Milk"], "5 alive na 650, 3 crowns milk na 900", 2, 900, "3 crowns milk na 900"],
    [["3 Crowns Milk", "5 Alive"], "3 crowns milk na 900, 5 alive na 700", 1, 900, "3 crowns milk na 900"],
    [["3 Crowns Milk", "5 Alive"], "3 crowns milk na 900, 5 alive na 700", 2, 700, "5 alive na 700"],
    [["Rice", "5 Alive"], "rice na 2000, 5 alive na 650", 1, 2000, "rice na 2000"],
    [["Rice", "5 Alive"], "rice na 2000, 5 alive na 650", 2, 650, "5 alive na 650"],
  ];
  for (const [names, said, item, naira, quote] of priced) {
    test(`${JSON.stringify(said)}: ${names[item - 1]} is ₦${naira}`, async () => {
      expect(await price(names, said, item, naira, quote)).toBe(naira);
    });
  }
});

describe("strict price chains", () => {
  async function rice(said: string, naira: number) {
    const spark = scriptedSpark([[setPrice(1, naira, "piece", said)], "done"]);
    const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "chain", [{ item: 1, name: "Rice" }], [said]);
    return r.lines[0]!.price?.naira ?? null;
  }
  const asked: [string, number][] = [
    ["rice na 2k 3k", 5000], ["rice na 1k 1k", 2000], ["rice na 2 thousand 3 thousand", 5000],
    ["rice na 5 hundred 6 hundred", 50600], ["rice na five hundred six hundred", 50600],
    ["rice na 1 hundred hundred", 10000], ["rice na 2 and 3 thousand", 5000],
    ["rice na 3 thousand 5", 3005], ["rice na two thousand five", 2005], ["rice na 2 million 3", 2000003],
    ["rice na 3k 500", 3500], ["rice na 5 hundred and 5 hundred", 50500], ["rice na 2 thousand thousand", 3000],
  ];
  for (const [said, naira] of asked) {
    test(`${JSON.stringify(said)} at ${naira} is asked`, async () => {
      expect(await rice(said, naira)).toBeNull();
    });
  }
  const priced: [string, number][] = [
    ["rice na 3 thousand 5 hundred", 3500], ["rice na 5 hundred thousand", 500000], ["rice na 2 hundred and 50", 250],
    ["rice na 3k 5 hundred", 3500], ["rice na 1 million", 1000000],
  ];
  for (const [said, naira] of priced) {
    test(`${JSON.stringify(said)} is ₦${naira}`, async () => {
      expect(await rice(said, naira)).toBe(naira);
    });
  }
});
