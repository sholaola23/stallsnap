import { describe, expect, test } from "bun:test";
import { applyTool, MAX_TURNS, numbersIn, priceNote, replyText, startPricing } from "./agent.ts";
import { testClient, textStream, toolStream } from "../test/fakes.ts";

const products = [
  { id: 1, name: "Peak milk tin" },
  { id: 2, name: "Golden Penny spaghetti" },
  { id: 3, name: "Indomie carton" },
];
const note = "Peak milk na 1,500 each. Spaghetti 900 per pack. Bread na 1k. Indomie, I go tell you later.";

const set = (id: number, amount: number, unit: string, quote: string) => ["set_price", { product_id: id, amount_naira: amount, unit, quote }] as [string, Record<string, unknown>];

describe("pricing a voice note", () => {
  test("Spark's checked tool calls fill the list; unpriced items become questions", async () => {
    const { client, calls } = testClient({
      "muse-spark-1.3": [
        toolStream([
          set(1, 1500, "each", "Peak milk na 1,500 each"),
          set(2, 900, "per pack", "Spaghetti 900 per pack"),
          ["not_in_photo", { quote: "Bread na 1k" }],
          ["ask_trader", { product_id: 3, question: "How much is one carton of Indomie?" }],
        ]),
        textStream("DONE"),
      ],
    });
    const state = await priceNote(client, startPricing(products), note);

    expect(state.lines.map((l) => [l.name, l.amount, l.unit])).toEqual([
      ["Peak milk tin", 1500, "each"],
      ["Golden Penny spaghetti", 900, "per pack"],
      ["Indomie carton", null, null],
    ]);
    expect(state.lines[2]!.question).toBe("How much is one carton of Indomie?");
    expect(state.notMatched).toEqual(["Bread na 1k"]);
    expect(calls).toHaveLength(2);

    // The second turn replays the calls and our results, so the model sees what was accepted.
    const replay = calls[1]!.body.input as { type: string; output?: string }[];
    expect(replay.filter((i) => i.type === "function_call_output").map((i) => i.output)).toEqual([
      "ok: Peak milk tin is ₦1500 each",
      "ok: Golden Penny spaghetti is ₦900 per pack",
      "ok: noted, no price set",
      "ok: will ask about Indomie carton",
    ]);

    const reply = replyText(state);
    expect(reply).toContain("1. Peak milk tin: ₦1,500 each");
    expect(reply).toContain("- How much is one carton of Indomie?");
    expect(reply).toContain('- "Bread na 1k"');
    expect(reply).toContain("reply YES to publish without them");
  });

  test("a product the model skips still gets a question", async () => {
    const { client } = testClient({ "muse-spark-1.3": textStream("DONE") });
    const state = await priceNote(client, startPricing(products), note);
    expect(state.lines.every((l) => l.amount === null && l.question === `How much is the ${l.name}?`)).toBe(true);
  });

  test("a model that never stops calling tools is cut off after the turn limit", async () => {
    const { client, calls } = testClient({ "muse-spark-1.3": toolStream([["ask_trader", { product_id: 3, question: "?" }]]) });
    await priceNote(client, startPricing(products), note);
    expect(calls).toHaveLength(MAX_TURNS);
  });

  test("a later note corrects an earlier price and keeps the rest", async () => {
    const first = testClient({ "muse-spark-1.3": [toolStream([set(1, 1500, "each", "Peak milk na 1,500 each")]), textStream("DONE")] });
    const before = await priceNote(first.client, startPricing(products), note);
    const correction = "Sorry, Peak milk na 1,600 now";
    const second = testClient({
      "muse-spark-1.3": [toolStream([set(1, 1600, "each", "Peak milk na 1,600"), ["ask_trader", { product_id: 2, question: "x" }]]), textStream("DONE")],
    });
    const after = await priceNote(second.client, before, correction);
    expect(after.lines[0]!.amount).toBe(1600);
    expect(before.lines[0]!.amount).toBe(1500); // the earlier state is not changed in place
    expect(after.notes).toEqual([note, correction]);
    const sent = (second.calls[0]!.body.input as any)[1].content[0].text as string;
    expect(sent).toContain("1. Peak milk tin: ₦1500 each");
  });
});

describe("tool calls the code refuses", () => {
  const run = (name: string, args: Record<string, unknown> | string) => {
    const state = startPricing(products);
    const result = applyTool(state, { name, arguments: typeof args === "string" ? args : JSON.stringify(args) }, note);
    return { state, result };
  };

  test("a price the trader never said (quote not in the note)", () => {
    const { state, result } = run("set_price", { product_id: 1, amount_naira: 1500, unit: "each", quote: "Peak milk na 1500 naira only" });
    expect(result).toStartWith("error: quote");
    expect(state.lines[0]!.amount).toBeNull();
  });

  test("an amount that doesn't match the number in the quote", () => {
    for (const amount of [15000, 150, 1501]) {
      const { state, result } = run("set_price", { product_id: 1, amount_naira: amount, unit: "each", quote: "Peak milk na 1,500 each" });
      expect(result).toContain("the quote says 1500");
      expect(state.lines[0]!.amount).toBeNull();
    }
  });

  test("a product that isn't in the photo", () => {
    expect(run("set_price", { product_id: 9, amount_naira: 1000, unit: "each", quote: "Bread na 1k" }).result).toContain("no product 9");
    expect(run("set_price", { product_id: "1", amount_naira: 1500, unit: "each", quote: "Peak milk na 1,500 each" }).result).toContain("no product 1");
  });

  test("zero, negative, fractional, string and absurd amounts", () => {
    for (const amount of [0, -1500, 1500.5, "1500", 60_000_000, null]) {
      expect(run("set_price", { product_id: 1, amount_naira: amount, unit: "each", quote: "Peak milk na 1,500 each" }).result).toContain("whole number");
    }
  });

  test("a blank unit", () => {
    expect(run("set_price", { product_id: 1, amount_naira: 1500, unit: "  ", quote: "Peak milk na 1,500 each" }).result).toContain("unit is required");
  });

  test("broken JSON and unknown tools", () => {
    expect(run("set_price", "{product_id: 1").result).toContain("not valid JSON");
    expect(run("delete_everything", {}).result).toContain("unknown tool");
  });

  test("not_in_photo needs the trader's words too", () => {
    const { state, result } = run("not_in_photo", { quote: "Fish na 3k" });
    expect(result).toStartWith("error");
    expect(state.notMatched).toEqual([]);
  });

  test("asking about a product that already has a price keeps the price", () => {
    const state = startPricing(products);
    applyTool(state, { name: "set_price", arguments: JSON.stringify({ product_id: 1, amount_naira: 1500, unit: "each", quote: "Peak milk na 1,500 each" }) }, note);
    expect(applyTool(state, { name: "ask_trader", arguments: JSON.stringify({ product_id: 1, question: "?" }) }, note)).toContain("kept");
    expect(state.lines[0]!.amount).toBe(1500);
  });

  test("clear_price removes a price and asks again", () => {
    const state = startPricing(products);
    applyTool(state, { name: "set_price", arguments: JSON.stringify({ product_id: 2, amount_naira: 900, unit: "per pack", quote: "Spaghetti 900" }) }, note);
    applyTool(state, { name: "clear_price", arguments: JSON.stringify({ product_id: 2, quote: "spaghetti 900 PER pack!" }) }, note);
    expect(state.lines[1]).toMatchObject({ amount: null, unit: null, question: "Do you still sell the Golden Penny spaghetti? If yes, how much?" });
  });
});

describe("numbers in a quote", () => {
  test("reads the ways traders write prices", () => {
    expect(numbersIn("Peak milk na 1,500")).toEqual([1500]);
    expect(numbersIn("na 2k each")).toEqual([2000]);
    expect(numbersIn("1.5k")).toEqual([1500]);
    expect(numbersIn("N800 for two")).toEqual([800]);
    expect(numbersIn("two thousand naira")).toEqual([]);
    expect(numbersIn("3 for 1000")).toEqual([3, 1000]);
  });
});

describe("the reply", () => {
  test("with everything priced it asks for YES", () => {
    const state = startPricing([{ id: 1, name: "Peak milk tin" }]);
    applyTool(state, { name: "set_price", arguments: JSON.stringify({ product_id: 1, amount_naira: 1500, unit: "each", quote: "1,500" }) }, note);
    expect(replyText(state)).toBe("Here is your price list:\n1. Peak milk tin: ₦1,500 each\n\nReply YES to publish, or send a voice note to change a price.");
  });
});
