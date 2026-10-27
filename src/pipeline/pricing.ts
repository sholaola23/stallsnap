// Prices from the trader's own words, with a Muse Spark tool loop.
//
// StallSnap never guesses a price. Spark may only call:
//   set_price(item, price_naira, unit, quote)  when the trader said the price
//   flag_missing_price(item, question)         when they didn't, or it's unclear
//   note_unlisted_item(name, quote)            a price for something not in the photo
// and every call is checked here before it counts:
// - the item must be one of the cut-outs;
// - the price must be whole naira from 10 to 5,000,000;
// - the unit must be one StallSnap knows;
// - the quote must appear in what the trader said, word for word (ignoring
//   case and punctuation);
// - if the quote holds digits, the price must match one of them (650, 1.8
//   meaning 1,800, 3k meaning 3,000).
// A refused call is answered with the reason, so Spark can correct it. Any
// item still without a price at the end is asked about. Nothing is guessed.
// An item priced but not in the photo is never added: the trader is told
// "You mentioned yam, send a photo of it", using their own words.
//
// Loop rules (https://dev.meta.ai/docs/tool-calling, /docs/protocols/responses):
// tool_choice can only be "auto", so a plain-text answer ends the loop; turns
// are capped here; the same call made 3 times stops the loop; history is
// replayed statelessly with store: false and encrypted reasoning.
import type { MetaClient } from "../meta/client.ts";
import { SPARK_MODEL, sparkMaxUsd, sparkUsd } from "../meta/costs.ts";
import { SparkError } from "../meta/spark.ts";
import { type QuoteContext, checkQuote, checkUnlisted } from "./quotes.ts";

export const MAX_TURNS = 4;
export const MAX_OUTPUT_TOKENS = 16_000;
export const MIN_PRICE = 10;
export const MAX_PRICE = 5_000_000;
/** At most this many items not in the photo are mentioned back to the trader. */
export const MAX_UNLISTED = 3;

export const SALE_UNITS = [
  "piece", "pack", "packet", "sachet", "tin", "bottle", "can", "bag", "carton", "crate", "cup", "paint bucket",
  "basin", "kg", "litre", "yard", "strip", "tuber", "bunch", "heap", "dozen", "roll", "pair", "set", "loaf", "tray",
] as const;
export type SaleUnit = (typeof SALE_UNITS)[number];

export type Line = {
  item: number; // 1-based, matching the cut-outs
  name: string;
  price: { naira: number; unit: SaleUnit; quote: string } | null;
  /** Set when the trader must be asked. */
  question: string | null;
};

export type ToolEvent = { turn: number; name: string; args: unknown; accepted: boolean; reason?: string };

export type PricingResult = {
  lines: Line[];
  /** Items the trader priced that aren't in the photo, in their own words ("yam"). */
  unlisted?: string[];
  events: ToolEvent[];
  turns: number;
  stopped: "all-done" | "model-finished" | "turn-cap" | "repeat-cap";
};

const TOOLS = [
  {
    type: "function",
    name: "set_price",
    description: "Record a price the trader clearly said for one item.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["item", "price_naira", "unit", "quote"],
      properties: {
        item: { type: "integer", description: "Item number from the list." },
        price_naira: { type: "integer", description: "Whole naira for one unit." },
        unit: { type: "string", enum: [...SALE_UNITS], description: "What one price buys." },
        quote: { type: "string", description: "The trader's exact words for this price, copied from the transcript." },
      },
    },
  },
  {
    type: "function",
    name: "flag_missing_price",
    description: "The trader did not clearly say this item's price. Give a short question to ask them.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["item", "question"],
      properties: {
        item: { type: "integer", description: "Item number from the list." },
        question: { type: "string", description: "Why the price is missing or unclear, in a few words (for the log; the trader gets a standard question)." },
      },
    },
  },
  {
    type: "function",
    name: "note_unlisted_item",
    description: "The trader said a price for something that is not on the list. StallSnap asks them to send a photo of it.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "quote"],
      properties: {
        name: { type: "string", description: "The item's name, copied from the trader's words." },
        quote: { type: "string", description: "The trader's exact words naming the item and its price, copied from the transcript." },
      },
    },
  },
];

const DEVELOPER = [
  "You fill in the prices of a market trader's catalogue from what the trader said.",
  "The trader often speaks Nigerian Pidgin, and a speech model transcribed it roughly, so words may be misheard.",
  "Only use a price the trader said. Never guess, estimate, or use typical market prices.",
  "For every item on the list, call set_price if the trader clearly said its price, copying their exact words for it as the quote,",
  "or flag_missing_price with a short question if they didn't say it or it is unclear which item a price belongs to.",
  "Pidgin number shorthand: \"1.8\" in thousands talk means 1,800; \"3k\" means 3,000; \"five-eight\" for a crate of eggs means 5,800.",
  "When the trader corrects themselves (\"no no, 3,500\"), use the last price.",
  "If the trader gives a range or two possible prices, flag the item and ask.",
  "Only price an item the trader names, followed by one plain price. A group price, a quantity (\"2 for 1000\"), a range or anything unclear: flag the item so the trader is asked.",
  "The unit is what one price buys: a sachet, a tin, a crate, a paint bucket, and so on. Prices are whole naira.",
  "If the trader gives a price for something that is not on the list, call note_unlisted_item with its name and their words. Never put that price on a listed item.",
  "When every item has a price or a question, stop.",
].join(" ");

type Checked = { ok: true } | { ok: false; reason: string };

/** The question the trader gets. Code writes it: the model's wording is never sent. */
export const questionFor = (name: string) => `How much is ${name}?`;

function checkCall(name: string, args: unknown, ctx: QuoteContext): { result: Checked; apply?: (lines: Map<number, Line>) => void; unlisted?: string } {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (name === "note_unlisted_item") {
    const v = checkUnlisted(ctx, typeof a.name === "string" ? a.name : "", typeof a.quote === "string" ? a.quote : "");
    return v.ok ? { result: { ok: true }, unlisted: v.name } : { result: v };
  }
  const item = a.item;
  const line = typeof item === "number" && Number.isInteger(item) ? ctx.items.find((i) => i.item === item) : undefined;
  if (!line) return { result: { ok: false, reason: `item must be one of ${ctx.items.map((i) => i.item).join(", ")}` } };

  if (name === "flag_missing_price") {
    return { result: { ok: true }, apply: (lines) => lines.set(line.item, { ...lines.get(line.item)!, price: null, question: questionFor(line.name) }) };
  }
  if (name !== "set_price") return { result: { ok: false, reason: `unknown tool ${name}` } };

  const naira = a.price_naira;
  if (typeof naira !== "number" || !Number.isInteger(naira) || naira < MIN_PRICE || naira > MAX_PRICE) {
    return { result: { ok: false, reason: `price_naira must be whole naira from ${MIN_PRICE} to ${MAX_PRICE}` } };
  }
  const unit = typeof a.unit === "string" ? a.unit.trim().toLowerCase() : "";
  if (!(SALE_UNITS as readonly string[]).includes(unit)) return { result: { ok: false, reason: `unit must be one of: ${SALE_UNITS.join(", ")}` } };
  const quote = typeof a.quote === "string" ? a.quote.trim() : "";
  const verdict = checkQuote(ctx, { ...line, unit }, naira, quote);
  if (!verdict.ok) return { result: verdict };
  return {
    result: { ok: true },
    apply: (lines) => {
      ctx.used.set(`${verdict.message}:${verdict.at}`, line.item);
      lines.set(line.item, { ...lines.get(line.item)!, price: { naira, unit: unit as SaleUnit, quote }, question: null });
    },
  };
}

export async function priceItems(
  client: MetaClient,
  jobId: string,
  items: readonly { item: number; name: string }[],
  said: readonly string[],
): Promise<PricingResult> {
  const lines = new Map<number, Line>(items.map((i) => [i.item, { item: i.item, name: i.name, price: null, question: null }]));
  const events: ToolEvent[] = [];
  const decided = new Set<number>();
  const ctx: QuoteContext = { items, said, used: new Map() };
  const repeats = new Map<string, number>();
  const unlisted: string[] = [];

  const listText = items.map((i) => `${i.item}. ${i.name}`).join("\n");
  const saidText = said.map((s, i) => `Message ${i + 1}: ${s}`).join("\n");
  const input: unknown[] = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: DEVELOPER }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: `Items on the stall:\n${listText}\n\nWhat the trader said:\n${saidText}` }] },
  ];
  const finish = (turns: number, stopped: PricingResult["stopped"]): PricingResult => {
    for (const line of lines.values()) if (!line.price && !line.question) line.question = questionFor(line.name);
    return { lines: [...lines.values()], unlisted: unlisted.slice(0, MAX_UNLISTED), events, turns, stopped };
  };

  if (items.length === 0) return finish(0, "all-done");

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const maxInputTokens = Math.ceil(JSON.stringify(input).length / 2) + 4000;
    const res = (await client.responses(
      { jobId, what: `spark pricing turn ${turn}`, maxUsd: sparkMaxUsd(maxInputTokens, MAX_OUTPUT_TOKENS) },
      { model: SPARK_MODEL, store: false, include: ["reasoning.encrypted_content"], max_output_tokens: MAX_OUTPUT_TOKENS, tools: TOOLS, input },
      (r) => sparkUsd((r as { usage?: unknown }).usage),
    )) as { status?: unknown; output?: unknown };
    if (res.status !== undefined && res.status !== "completed") throw new SparkError(`pricing turn ${turn}: response ${String(res.status)}`);

    const output = Array.isArray(res.output) ? res.output.filter((o) => typeof o === "object" && o !== null) : [];
    const calls = output.filter((o) => (o as { type?: unknown }).type === "function_call") as { name?: unknown; arguments?: unknown; call_id?: unknown }[];
    input.push(...output);
    if (calls.length === 0) return finish(turn, "model-finished");

    let repeated = false;
    // Notes of items not in the photo go first, so a listed item's price can end where they start.
    const ordered = [...calls.filter((c) => c.name === "note_unlisted_item"), ...calls.filter((c) => c.name !== "note_unlisted_item")];
    for (const call of ordered) {
      const name = String(call.name ?? "");
      let args: unknown;
      try {
        args = JSON.parse(String(call.arguments ?? ""));
      } catch {
        args = undefined;
      }
      const key = `${name}\n${JSON.stringify(args)}`;
      const seen = (repeats.get(key) ?? 0) + 1;
      repeats.set(key, seen);
      if (seen >= 3) repeated = true;

      const checked = args === undefined ? { result: { ok: false as const, reason: "arguments must be JSON" } } : checkCall(name, args, ctx);
      const { result, apply } = checked;
      const extra = "unlisted" in checked ? checked.unlisted : undefined;
      // Every accepted name marks where a listed item's words end; only the first few are mentioned back.
      if (result.ok && extra !== undefined && !unlisted.includes(extra)) {
        unlisted.push(extra);
        ctx.unlisted = unlisted.map((name, i) => ({ item: -1 - i, name }));
      }
      if (result.ok && apply) {
        apply(lines);
        decided.add((args as { item: number }).item);
      }
      events.push({ turn, name, args, accepted: result.ok, ...(result.ok ? {} : { reason: result.reason }) });
      input.push({ type: "function_call_output", call_id: String(call.call_id ?? ""), output: JSON.stringify(result.ok ? { ok: true } : { ok: false, error: result.reason }) });
    }
    if (repeated) return finish(turn, "repeat-cap");
    if (decided.size === items.length) return finish(turn, "all-done");
  }
  return finish(MAX_TURNS, "turn-cap");
}
