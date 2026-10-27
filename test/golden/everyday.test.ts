// Golden suite: ordinary voice notes and typed lists, with the exact price for every item.
// A change to the price parser must never break these.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../../src/meta/client.ts";
import { priceItems } from "../../src/pipeline/pricing.ts";
import { checkQuote, segments } from "../../src/pipeline/quotes.ts";
import { scriptedSpark, setPrice } from "../../src/pipeline/test-spark.ts";
import { SpendGuard } from "../../src/spend-guard.ts";

let dir: string;
let guard: SpendGuard;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "golden-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const RG = ["Rice", "Garri"];
const RB = ["Rice", "Beans"];
// [item names, what the trader said, the price of each item in order]
const NOTES: [string[], string, number[]][] = [
  [RG, "rice na 15 thousand, garri na 900", [15000, 900]],
  [RG, "rice na 15 thousand garri na 900", [15000, 900]],
  [RG, "Rice na 15 thousand. Garri na 900.", [15000, 900]],
  [RG, "rice na 15 thousand naira, garri na 900 naira", [15000, 900]],
  [RG, "rice na 5 hundred, garri na 9 hundred", [500, 900]],
  [RG, "rice na 50 hundred garri na 900", [5000, 900]],
  [RG, "rice na 2 thousand 5 hundred, garri na 9 hundred", [2500, 900]],
  [RG, "rice na two thousand, garri na five hundred", [2000, 500]],
  [RG, "rice na fifteen hundred, garri na nine hundred", [1500, 900]],
  [RG, "rice na 2k5, garri na 900", [2500, 900]],
  [RG, "rice na 1.5k, garri na 900", [1500, 900]],
  [RG, "rice na N1500, garri na N900", [1500, 900]],
  [RG, "rice ₦1,500 garri ₦900", [1500, 900]],
  [RG, "rice na 1500 naira garri na 900 naira", [1500, 900]],
  [RG, "Rice: 1500\nGarri: 900", [1500, 900]],
  [RG, "rice 1500\ngarri 900", [1500, 900]],
  [RG, "1. Rice: ₦1,500 per cup\n2. Garri: ₦900 per cup", [1500, 900]],
  [RG, "Rice na 1500 abeg, garri na 900", [1500, 900]],
  [RG, "rice na 1500 o, garri na 900 o", [1500, 900]],
  [RG, "rice na 1500 then garri na 900", [1500, 900]],
  [RG, "rice na 1500, no sorry 1600. garri na 900", [1600, 900]],
  [RB, "1. rice 1500 2. beans 3500", [1500, 3500]],
  [RB, "rice go for 1500, beans go for 3500", [1500, 3500]],
  [RB, "rice dey go for 2k, beans dey go for 3.5k", [2000, 3500]],
  [RB, "I dey sell rice for 1500, beans for 3500", [1500, 3500]],
  [RB, "rice na 3000 beans na 3500", [3000, 3500]],
  [RB, "rice 3000 beans 3500", [3000, 3500]],
  [RB, "rice 3000, beans 3500", [3000, 3500]],
  [["Rice", "Beans", "Garri"], "rice 1500, beans 3500, garri 900", [1500, 3500, 900]],
  [["Rice", "Beans", "Garri", "Yam"], "rice 1500, beans 3500, garri 900, yam 2000", [1500, 3500, 900, 2000]],
  [["Peak milk 400g", "Milo"], "peak milk 400g na 1500 and milo na 200", [1500, 200]],
  [["Milo", "Peak milk"], "milo na 200 and peak milk na 400", [200, 400]],
  [["Indomie", "Egg"], "indomie na 250, egg na 150", [250, 150]],
  [["Bread", "Butter"], "bread 1200 butter 800", [1200, 800]],
  [["Sugar", "Salt"], "sugar na 1,200 naira, salt na 300 naira", [1200, 300]],
  [["Palm oil", "Groundnut oil"], "palm oil 2500 per bottle, groundnut oil 3000 per bottle", [2500, 3000]],
  [["5 Alive", "3 Crowns Milk"], "5 alive na 650, 3 crowns milk na 900", [650, 900]],
  [["Rice", "5 Alive"], "rice na 1500, five alive na 700", [1500, 700]],
  [["Eggs 30", "Bread"], "eggs 30 na 2500, bread na 1200", [2500, 1200]],
  [["Pure water", "Gala"], "pure water na 50. gala na 200", [50, 200]],
  // From #6 QA's everyday gate on 830278e.
  [RB, "rice 15 thousand beans 3 thousand", [15000, 3000]],
  [["Rice", "Generator"], "rice na 1.5 million, generator na 2 hundred thousand", [1500000, 200000]],
  [RB, "rice na 2 hundred and 50, beans na 300", [250, 300]],
  [RB, "rice na 5 hundred beans na 6 hundred", [500, 600]],
  [["Peak milk", "Milo", "Sugar"], "peak milk na 1 thousand, milo na 2 thousand, sugar na 800 naira", [1000, 2000, 800]],
  [RB, "rice na twenty thousand, beans na fifteen thousand five hundred", [20000, 15500]],
  [RB, "rice, 3 thousand. beans, 2 thousand.", [3000, 2000]],
  [["Rice", "Beans", "Garri"], "1. rice 3000 2. beans 3500 3. garri 1500", [3000, 3500, 1500]],
  [["Rice", "Garri"], "rice 15k garri 900", [15000, 900]],
  [["Peak milk", "Milo", "Indomie"], "Peak milk na 650. Milo na 1,000. Indomie na 250.", [650, 1000, 250]],
  [["Rice", "Garri", "Beans"], "rice na 15 thousand and garri na 900 and beans na 2k", [15000, 900, 2000]],
];

describe("everyday voice notes: every item gets exactly the price said", () => {
  for (const [names, said, prices] of NOTES) {
    const items = names.map((name, i) => ({ item: i + 1, name }));
    test(JSON.stringify(said), async () => {
      const { tokens, segments: segs } = segments(said, items);
      expect(segs.map((s) => s.price?.value ?? s.unclear ?? "no price")).toEqual(prices);
      // End to end: Spark quotes each item's own words, and every price is accepted as said.
      const calls = segs.map((s) => setPrice(s.item, prices[s.item - 1]!, "piece", tokens.slice(s.start, s.price!.to).join(" ")));
      const spark = scriptedSpark([calls, "done"]);
      const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "golden", items, [said]);
      expect(r.lines.map((l) => l.price?.naira ?? null)).toEqual(prices);
      // And another item's price is never accepted for this one.
      for (const it of items) {
        for (const other of prices.filter((p) => p !== prices[it.item - 1])) {
          expect(checkQuote({ items, said: [said], used: new Map() }, it, other, said).ok).toBe(false);
        }
      }
    });
  }
  test("there are at least 30 notes", () => expect(NOTES.length).toBeGreaterThanOrEqual(30));
});
