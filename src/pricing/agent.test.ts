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
      expect(result).toContain("the trader said 1500");
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
    expect(state.lines[1]).toMatchObject({ amount: null, unit: null, removed: false, question: "How much is the Golden Penny spaghetti now?" });
  });
});

describe("numbers in a quote", () => {
  test("reads the ways traders write prices", () => {
    expect(numbersIn("Peak milk na 1,500")).toEqual([1500]);
    expect(numbersIn("na 2k each")).toEqual([2000]);
    expect(numbersIn("1.5k")).toEqual([1500]);
    expect(numbersIn("N800 for two")).toEqual([800, 2]);
    expect(numbersIn("two thousand naira")).toEqual([2000]);
    expect(numbersIn("3 for 1000")).toEqual([3, 1000]);
  });
});

describe("the reply", () => {
  test("with everything priced it asks for YES", () => {
    const state = startPricing([{ id: 1, name: "Peak milk tin" }]);
    applyTool(state, { name: "set_price", arguments: JSON.stringify({ product_id: 1, amount_naira: 1500, unit: "each", quote: "Peak milk na 1,500" }) }, note);
    expect(replyText(state)).toBe("Here is your price list:\n1. Peak milk tin: ₦1,500 each\n\nReply YES to publish, or send a voice note to change a price.");
  });
});

// QA round 1 (30 Oct): ways round the price guard. Each must stay refused.
describe("a price nobody said is refused", () => {
  const two = [
    { id: 1, name: "Peak milk tin" },
    { id: 2, name: "Milo tin" },
  ];
  const set = (id: number, amount: number, quote: string) => ({
    name: "set_price",
    arguments: JSON.stringify({ product_id: id, amount_naira: amount, unit: "each", quote }),
  });

  test("A1 spoken numbers are checked: five hundred is not 5000", () => {
    const state = startPricing(two);
    const said = "Peak milk na five hundred naira";
    expect(applyTool(state, set(1, 5000, said), said)).toStartWith("error");
    expect(state.lines[0]!.amount).toBeNull();
    expect(applyTool(state, set(1, 500, said), said)).toStartWith("ok");
    expect(state.lines[0]!.amount).toBe(500);
  });

  test("A2 a quote must be whole words, at least two, with a price in it", () => {
    const state = startPricing(two);
    const said = "Peak milk 500, Milo no dey";
    expect(applyTool(state, set(2, 9000, "k"), said)).toStartWith("error");
    expect(applyTool(state, set(2, 9000, "lk 5"), said)).toStartWith("error");
    expect(applyTool(state, set(2, 9000, "Milo no dey"), said)).toStartWith("error");
    expect(state.lines[1]!.amount).toBeNull();
  });

  test("A3 a quote covering two products is refused; each product quotes its own words", () => {
    const state = startPricing(two);
    const said = "Peak 500, Milo 1500";
    for (const [id, amount] of [[1, 1500], [1, 500], [2, 500], [2, 1500]] as const) {
      expect(applyTool(state, set(id, amount, said), said)).toStartWith("error: the quote has more than one price");
    }
    expect(applyTool(state, set(1, 1500, "Peak 500"), said)).toStartWith("error");
    expect(applyTool(state, set(2, 500, "Peak 500"), said)).toStartWith("error: the quote must name this product");
    expect(applyTool(state, set(1, 500, "Peak 500"), said)).toStartWith("ok");
    expect(applyTool(state, set(2, 1500, "Milo 1500"), said)).toStartWith("ok");
    expect(state.lines.map((l) => l.amount)).toEqual([500, 1500]);
  });

  test("B1 a quote that cuts a number short is refused", () => {
    const state = startPricing(two);
    const said = "Peak milk na two thousand five hundred";
    expect(applyTool(state, set(1, 2000, "Peak milk na two thousand"), said)).toStartWith("error: the quote cuts a number short");
    expect(applyTool(state, set(1, 2, "Peak milk na 2"), "Peak milk na 2 k each")).toStartWith("error");
    expect(applyTool(state, set(2, 1, "Milo na 1.5"), "Milo na 1.5 k")).toStartWith("error");
    expect(state.lines.map((l) => l.amount)).toEqual([null, null]);
    expect(applyTool(state, set(1, 2500, said), said)).toStartWith("ok");
  });

  test("B3 and C1: with prices before or after the product, only that product's own words count", () => {
    for (const said of ["na 500 for Peak, 1500 for Milo", "na 500 for Peak 1500 for Milo", "Peak na 500 Milo na 1500"]) {
      const state = startPricing(two);
      expect(applyTool(state, set(1, 1500, said), said)).toStartWith("error");
      expect(applyTool(state, set(2, 500, said), said)).toStartWith("error");
      expect(applyTool(state, set(1, 500, said), said)).toStartWith("error");
      expect(state.lines.map((l) => l.amount)).toEqual([null, null]);
    }
    const state = startPricing(two);
    expect(applyTool(state, set(1, 500, "500 for Peak"), "na 500 for Peak 1500 for Milo")).toStartWith("ok");
    expect(applyTool(state, set(2, 1500, "Milo na 1500"), "Peak na 500 Milo na 1500")).toStartWith("ok");
    expect(applyTool(state, set(2, 500, "500 Milo"), "Peak na 500 Milo na 1500")).toStartWith("error");
  });

  test("a deal is read as its price, not its count", () => {
    const state = startPricing(two);
    const said = "Peak na two for 1000";
    expect(applyTool(state, set(1, 2, said), said)).toStartWith("error");
    expect(applyTool(state, set(1, 1000, said), said)).toStartWith("ok");
  });

  test("'number 12' names the product and is not a price", () => {
    const state = startPricing([{ id: 1, name: "Tomato" }, { id: 12, name: "Pepper" }]);
    expect(applyTool(state, set(12, 500, "number 12 na 500"), "number 12 na 500")).toStartWith("ok");
    expect(applyTool(state, set(1, 500, "number 12 na 500"), "number 12 na 500")).toStartWith("error: the quote must name this product");
  });

  test("two numbers and no product word is refused rather than guessed", () => {
    const state = startPricing(two);
    const said = "this one 500 that one 1500";
    expect(applyTool(state, set(1, 500, said), said)).toStartWith("error");
  });

  test("the ways traders say prices are read", () => {
    const cases: [string, number][] = [
      ["Peak milk na two thousand five hundred", 2500],
      ["Peak milk na two thousand five", 2500],
      ["Peak milk na one k", 1000],
      ["Peak milk na 2 thousand 500", 2500],
      ["Peak milk na twenty five thousand naira", 25000],
      ["Peak milk na one thousand and five hundred", 1500],
      ["Peak milk two for 1000", 1000],
      ["Peak milk this one na 800", 800],
      ["Peak milk N1,500", 1500],
    ];
    for (const [said, amount] of cases) {
      const state = startPricing(two);
      expect(`${said}: ${applyTool(state, set(1, amount, said), said)}`).toBe(`${said}: ok: Peak milk tin is ₦${amount} each`);
    }
  });
});

describe("the trader changes the list", () => {
  const two = [
    { id: 1, name: "Tomato" },
    { id: 2, name: "Blue soap bar" },
  ];
  const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) });

  test("A4 'I no dey sell am' takes the product off the list, with no question", () => {
    const state = startPricing(two);
    const said = "Tomato 500. I no dey sell soap again";
    expect(applyTool(state, call("remove_product", { product_id: 2, quote: "I no dey sell soap again" }), said)).toStartWith("ok");
    expect(state.lines[1]).toMatchObject({ removed: true, amount: null, question: null });
    expect(applyTool(state, call("ask_trader", { product_id: 2, question: "How much?" }), said)).toContain("kept off");
    const reply = replyText(state);
    expect(reply).toContain("Taken off your list:\n- Blue soap bar");
    expect(reply).not.toContain("How much is the Blue soap bar");
  });

  test("removing needs the trader's words", () => {
    const state = startPricing(two);
    expect(applyTool(state, call("remove_product", { product_id: 2, quote: "no longer sold" }), "Tomato 500")).toStartWith("error");
    expect(state.lines[1]!.removed).toBe(false);
  });

  test("a price later puts a removed product back", () => {
    const state = startPricing(two);
    applyTool(state, call("remove_product", { product_id: 2, quote: "no dey sell soap" }), "I no dey sell soap");
    applyTool(state, call("set_price", { product_id: 2, amount_naira: 300, unit: "each", quote: "soap na 300" }), "soap na 300");
    expect(state.lines[1]).toMatchObject({ removed: false, amount: 300 });
  });

  test("a wrong name is corrected with the trader's own word", () => {
    const state = startPricing([{ id: 4, name: "black seeds" }]);
    const said = "number 4 na egusi, 2k per cup";
    expect(applyTool(state, call("rename_product", { product_id: 4, new_name: "Egusi", quote: "number 4 na egusi" }), said)).toStartWith("ok");
    expect(state.lines[0]!.name).toBe("Egusi");
    expect(state.products[0]!.name).toBe("Egusi");
  });

  test("a new name the trader never said is refused", () => {
    const state = startPricing([{ id: 4, name: "black seeds" }]);
    const said = "number 4 na egusi";
    expect(applyTool(state, call("rename_product", { product_id: 4, new_name: "Premium egusi", quote: said }), said)).toStartWith("error");
    expect(applyTool(state, call("rename_product", { product_id: 4, new_name: "Ogbono", quote: "na ogbono" }), said)).toStartWith("error");
    expect(state.lines[0]!.name).toBe("black seeds");
  });

  test("the price list uses the photo's numbers, so 'number 4' means the same thing everywhere", () => {
    const state = startPricing([{ id: 3, name: "Tomato" }, { id: 4, name: "Egusi" }]);
    applyTool(state, call("set_price", { product_id: 4, amount_naira: 2000, unit: "per cup", quote: "egusi 2k" }), "egusi 2k");
    expect(replyText(state)).toContain("4. Egusi: ₦2,000 per cup");
  });
});
