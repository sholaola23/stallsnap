// Muse Spark matches the prices in the trader's note to the products from the photo, using tool
// calls (https://dev.meta.ai/docs/tool-calling). Our code checks every call before it changes the
// list: a price must quote the trader's own words, and a product must come from the photo.
import { MetaClient, type StreamEvent } from "../meta/client.ts";

export const SPARK_MODEL = "muse-spark-1.3";
export const MAX_TURNS = 6;
const MAX_NAIRA = 50_000_000;

export interface Product {
  id: number;
  name: string;
}

export interface PriceLine {
  productId: number;
  name: string;
  amount: number | null; // whole naira; null until the trader gives one
  unit: string | null; // what the price buys: "each", "per tin", "per paint bucket"
  quote: string | null; // the trader's own words the price came from
  question: string | null; // what to ask the trader when there is no price yet
}

export interface PricingState {
  products: Product[];
  lines: PriceLine[]; // one per product, same order
  notMatched: string[]; // things the trader priced that aren't in the photo
  notes: string[]; // every transcript, in order
}

export function startPricing(products: readonly Product[]): PricingState {
  return {
    products: [...products],
    lines: products.map((p) => ({ productId: p.id, name: p.name, amount: null, unit: null, quote: null, question: null })),
    notMatched: [],
    notes: [],
  };
}

const TOOLS = [
  {
    type: "function",
    name: "set_price",
    description: "Record the price the trader said for one product from the photo. Call once per product.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["product_id", "amount_naira", "unit", "quote"],
      properties: {
        product_id: { type: "integer", description: "The id of the product from the photo list." },
        amount_naira: { type: "integer", description: "The price in whole naira. '1k' is 1000, 'two thousand five hundred' is 2500." },
        unit: { type: "string", description: "What the price buys, in a few words: 'each', 'per tin', 'per paint bucket', 'per yard', 'for three'." },
        quote: { type: "string", description: "The exact words from the voice note where the trader gave this price, copied character for character." },
      },
    },
  },
  {
    type: "function",
    name: "ask_trader",
    description: "The trader gave no clear price for this product, or it could match more than one product. Ask one short question.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["product_id", "question"],
      properties: {
        product_id: { type: "integer" },
        question: { type: "string", description: "A short, friendly question in simple English, for example 'How much is the Peak milk tin?'" },
      },
    },
  },
  {
    type: "function",
    name: "not_in_photo",
    description: "The trader priced something that is not in the photo list. Do not set a price for it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["quote"],
      properties: { quote: { type: "string", description: "The exact words from the voice note about that item." } },
    },
  },
  {
    type: "function",
    name: "clear_price",
    description: "The trader took back a price, or says they no longer sell this product.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["product_id", "quote"],
      properties: { product_id: { type: "integer" }, quote: { type: "string" } },
    },
  },
];

const INSTRUCTIONS = `You help a Nigerian market trader price the goods in a photo of their stall.
The trader recorded a voice note, often in Nigerian Pidgin, saying their prices. The transcript may contain recognition mistakes.
For every product in the photo list, call exactly one tool: set_price when the note gives its price, otherwise ask_trader.
If the note prices something that is not in the list, call not_in_photo. Never invent a price, and never set a price the trader did not say.
Later notes can correct earlier prices: the latest note wins. When everything is handled, reply with the single word DONE.`;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function listText(state: PricingState): string {
  return state.lines
    .map((l) => `${l.productId}. ${l.name}: ${l.amount === null ? "no price yet" : `₦${l.amount} ${l.unit}`}`)
    .join("\n");
}

// Numbers written in a quote: "1,500", "1500", "2k", "1.5k", "N800". Spoken-word numbers return none.
export function numbersIn(quote: string): number[] {
  const found: number[] = [];
  for (const match of quote.toLowerCase().matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?/g)) {
    const value = Number(match[1]!.replace(/,/g, "")) * (match[2] ? 1000 : 1);
    if (Number.isFinite(value)) found.push(Math.round(value));
  }
  return found;
}

interface ToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

// Runs one tool call against the state. Returns the result text the model sees.
export function applyTool(state: PricingState, call: { name: string; arguments: string }, note: string): string {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return "error: arguments were not valid JSON";
  }
  const heard = normalise(note);
  const quoteOk = (q: unknown) => typeof q === "string" && normalise(q).length > 0 && heard.includes(normalise(q));
  const line = state.lines.find((l) => l.productId === args.product_id);

  switch (call.name) {
    case "set_price": {
      if (!line) return `error: there is no product ${String(args.product_id)} in the photo list`;
      const amount = args.amount_naira;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_NAIRA) {
        return "error: amount_naira must be a whole number of naira above 0";
      }
      const unit = typeof args.unit === "string" ? args.unit.trim() : "";
      if (!unit) return "error: unit is required, for example 'each'";
      if (!quoteOk(args.quote)) return "error: quote must be copied exactly from the voice note";
      const written = numbersIn(String(args.quote));
      if (written.length > 0 && !written.includes(amount)) {
        return `error: the quote says ${written.join(" or ")}, not ${amount}; quote the words where this price is said`;
      }
      Object.assign(line, { amount, unit, quote: String(args.quote).trim(), question: null });
      return `ok: ${line.name} is ₦${amount} ${unit}`;
    }
    case "ask_trader": {
      if (!line) return `error: there is no product ${String(args.product_id)} in the photo list`;
      // A price from an earlier note stands until the trader changes or clears it.
      if (line.amount !== null) return `ok: ${line.name} already has a price, kept`;
      const question = typeof args.question === "string" ? args.question.trim() : "";
      line.question = question || `How much is the ${line.name}?`;
      return `ok: will ask about ${line.name}`;
    }
    case "not_in_photo": {
      if (!quoteOk(args.quote)) return "error: quote must be copied exactly from the voice note";
      state.notMatched.push(String(args.quote).trim());
      return "ok: noted, no price set";
    }
    case "clear_price": {
      if (!line) return `error: there is no product ${String(args.product_id)} in the photo list`;
      if (!quoteOk(args.quote)) return "error: quote must be copied exactly from the voice note";
      Object.assign(line, { amount: null, unit: null, quote: null, question: `Do you still sell the ${line.name}? If yes, how much?` });
      return `ok: cleared ${line.name}`;
    }
    default:
      return `error: unknown tool ${call.name}`;
  }
}

function toolCalls(events: readonly StreamEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events) {
    const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
    if (event.type === "response.output_item.done" && item?.type === "function_call" && item.call_id && item.name) {
      calls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments ?? "" });
    }
  }
  return calls;
}

// Applies one voice note (the first, or a correction) to the price list.
export async function priceNote(client: MetaClient, state: PricingState, transcript: string): Promise<PricingState> {
  const next: PricingState = structuredClone(state);
  next.notes.push(transcript);
  const input: unknown[] = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: INSTRUCTIONS }] },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `Photo list, with prices so far:\n${listText(next)}\n\nVoice note transcript:\n${transcript}` }],
    },
  ];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const events = await client.respond({ model: SPARK_MODEL, input, tools: TOOLS });
    const calls = toolCalls(events);
    if (calls.length === 0) break;
    for (const call of calls) {
      input.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments });
      input.push({ type: "function_call_output", call_id: call.call_id, output: applyTool(next, call, transcript) });
    }
  }
  // Anything the model left alone still needs the trader's answer.
  for (const line of next.lines) {
    if (line.amount === null && !line.question) line.question = `How much is the ${line.name}?`;
  }
  return next;
}

// The message the trader reads back. Written by our code, not the model, so it can't drift.
export function replyText(state: PricingState): string {
  const naira = (n: number) => `₦${n.toLocaleString("en-GB")}`;
  const priced = state.lines.filter((l) => l.amount !== null);
  const asks = state.lines.filter((l) => l.amount === null);
  const parts: string[] = [];
  if (priced.length) {
    parts.push("Here is your price list:\n" + priced.map((l, i) => `${i + 1}. ${l.name}: ${naira(l.amount!)} ${l.unit}`).join("\n"));
  }
  if (asks.length) parts.push("I still need:\n" + asks.map((l) => `- ${l.question}`).join("\n"));
  if (state.notMatched.length) {
    parts.push(
      "These weren't in your photo, so they're not on the list. Send a photo if you want them added:\n" +
        state.notMatched.map((q) => `- "${q}"`).join("\n"),
    );
  }
  parts.push(asks.length ? "Send a voice note with the missing prices, or reply YES to publish without them." : "Reply YES to publish, or send a voice note to change a price.");
  return parts.join("\n\n");
}
