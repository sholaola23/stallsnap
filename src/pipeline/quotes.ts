// The quote verifier: decides, in code, whether what the trader said supports
// one price for one item. Spark's set_price call is accepted only when this
// says yes. Anything unclear is a no, and the trader is asked.
//
// A quote is accepted when:
// 1. it appears as whole words in one message the trader sent;
// 2. code reads exactly one price from it, equal to the price Spark set
//    (digits or English number words; "650" is 650, "1.8" and "3k" are
//    thousands, "1.500" is 1,500, "5-8" is 5,800); a number with a letter in
//    it, a range or two prices is unreadable;
// 3. it sits in this item's stretch of speech, which runs up to a mention of
//    another item, and that stretch names this item (or says "all the tins"
//    for an item sold by the tin);
// 4. its price is the trader's last word on the item: any other price in the
//    stretch must come before it with a correction ("no", "sorry") between,
//    and no later message prices the item again;
// 5. no other item has the same name, and the quote wasn't already used for
//    another item unless the stretch has a group word ("all", "each").

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, tousand: 1000, million: 1_000_000 };
const THOUSAND_WORDS = new Set(["k", "thousand", "tousand"]);
// Not "abeg": in Pidgin it is mostly "please" ("abeg buy"), so it can't mark a correction.
const CORRECTIONS = new Set(["no", "sorry", "mean", "correction", "wait"]);
const GROUP_WORDS = new Set(["all", "each", "every", "both"]);
const RANGE_WORDS = new Set(["to", "or", "abi", "between"]);
/** Words that describe packaging or size, not which product an item is. */
const GENERIC = new Set([
  "piece", "pack", "packet", "sachet", "tin", "bottle", "can", "bag", "carton", "crate", "cup", "paint", "bucket", "basin", "kg",
  "litre", "yard", "strip", "tuber", "bunch", "heap", "dozen", "roll", "pair", "set", "loaf", "tray", "small", "big", "large",
  "medium", "the", "and", "of", "with", "for", "per", "one", "new",
]);

export type Price = { value: number; at: number };
export type Spoken = { tokens: string[]; prices: Price[]; unreadable: number[] };

const singular = (w: string) => (w.length > 3 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

/** Lower-cased words, keeping numbers whole: "₦1,500" -> "1500", "1.8" stays, "5-8" stays, "1000-1200" splits. */
export function tokenize(text: string): string[] {
  const t = text
    .toLowerCase()
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/₦/g, " ")
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // 1,500 -> 1500
    .replace(/(\d+)\s*-\s*(\d+)/g, (_m, a: string, b: string) => (a.length === 1 && b.length === 1 ? `${a}-${b}` : `${a} - ${b}`))
    .replace(/(\d)\.(?=\d)/g, "$1\u0000") // protect decimal points
    .replace(/[^\p{L}\p{N}\u0000\- ]+/gu, " ")
    .replace(/\u0000/g, ".")
    .replace(/(^|\s)-|-(\s|$)/g, " ");
  return t.split(/\s+/).filter(Boolean);
}

function digitValue(token: string, next: string | undefined): { value: number; consumed: number } | "unreadable" | undefined {
  const m = /^n?(\d+)(?:\.(\d+))?(k)?$/.exec(token);
  if (!m) {
    if (/^\d-\d$/.test(token)) {
      // "1-8" is one-eight, 1,800. "5-8 thousand" or "5-8k" is a range, never one price.
      if (next !== undefined && THOUSAND_WORDS.has(next)) return "unreadable";
      return { value: Number(token[0]) * 1000 + Number(token[2]) * 100, consumed: 1 };
    }
    return /\d/.test(token) ? "unreadable" : undefined;
  }
  const [, whole, decimals, k] = m;
  const thousand = k !== undefined || (next !== undefined && THOUSAND_WORDS.has(next));
  const consumed = k === undefined && thousand ? 2 : 1;
  if (decimals === undefined) return { value: Number(whole) * (thousand ? 1000 : 1), consumed };
  if (!thousand && decimals.length === 3) return { value: Number(`${whole}${decimals}`), consumed }; // 1.500
  if (decimals.length > 2) return "unreadable";
  // "650.50" is not 650,500: without k or "thousand", only a small whole part means thousands.
  if (!thousand && Number(whole) >= 100) return "unreadable";
  // "1.8" said about naira prices means 1,800, as does "1.8k".
  return { value: Math.round(Number(`${whole}.${decimals}`) * 1000), consumed };
}

/** Reads number words starting at `i`: "two thousand five hundred" -> 2500. */
function wordValue(tokens: string[], i: number): { value: number; consumed: number } | undefined {
  let total = 0;
  let current = 0;
  let j = i;
  let any = false;
  for (; j < tokens.length; j++) {
    const w = tokens[j]!;
    if (w in NUMBER_WORDS) {
      current += NUMBER_WORDS[w]!;
      any = true;
    } else if (w in SCALES && any) {
      const scale = SCALES[w]!;
      if (scale === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * scale;
        current = 0;
      }
    } else if (w === "and" && any && j + 1 < tokens.length && tokens[j + 1]! in NUMBER_WORDS) {
      continue;
    } else break;
  }
  return any ? { value: total + current, consumed: j - i } : undefined;
}

/** Every price expression in a message, with the token it starts at. */
/**
 * Reads every price in `text`. Words in `nameWords` (item-name words with a digit in them, such as
 * "400g" or "7up") are part of a name, not numbers.
 */
export function readSpoken(text: string, nameWords: ReadonlySet<string> = new Set()): Spoken {
  const tokens = tokenize(text);
  let prices: Price[] = [];
  const unreadable: number[] = [];
  const numbers: { at: number; end: number }[] = []; // every number, small ones too, for finding ranges
  for (let i = 0; i < tokens.length; ) {
    if (nameWords.has(tokens[i]!)) {
      i++;
      continue;
    }
    const d = digitValue(tokens[i]!, tokens[i + 1]);
    if (d === "unreadable") {
      unreadable.push(i);
      i++;
      continue;
    }
    if (d) {
      prices.push({ value: d.value, at: i });
      numbers.push({ at: i, end: i + d.consumed });
      i += d.consumed;
      continue;
    }
    const w = wordValue(tokens, i);
    if (w) numbers.push({ at: i, end: i + w.consumed });
    // A lone "one" ("one cup") isn't a price; number words count from ten, or with a scale.
    if (w && (w.value >= 10 || w.consumed > 1)) {
      prices.push({ value: w.value, at: i });
      i += w.consumed;
      continue;
    }
    i += w ? w.consumed : 1;
  }
  // A range is never one price: "5 to 8k", "two to three thousand", "1,000-1,200" (a dash between
  // numbers reads as two numbers side by side). Both ends become unreadable, so the item is asked.
  for (let k = 0; k + 1 < numbers.length; k++) {
    const a = numbers[k]!;
    const b = numbers[k + 1]!;
    const gap = tokens.slice(a.end, b.at);
    if (gap.length === 0 || (gap.length === 1 && RANGE_WORDS.has(gap[0]!))) {
      for (const n of [a, b]) if (!unreadable.includes(n.at)) unreadable.push(n.at);
    }
  }
  prices = prices.filter((p) => !unreadable.includes(p.at));
  unreadable.sort((x, y) => x - y);
  return { tokens, prices, unreadable };
}

export type QuoteItem = { item: number; name: string; unit?: string };

/** The words that pick out an item, with packaging words added only where two items would otherwise look the same. */
export function itemKeys(items: readonly QuoteItem[]): Map<number, string[]> {
  // Sizes and numbers in a name ("400g", "50kg") aren't needed to say which item, unless two items differ only by them.
  const distinctive = (name: string) => [...new Set(tokenize(name).map(singular).filter((w) => w.length >= 3 && !GENERIC.has(w) && !/\d/.test(w)))];
  const keys = new Map<number, string[]>();
  for (const it of items) {
    let key = distinctive(it.name);
    const clash = items.some((o) => o.item !== it.item && distinctive(o.name).join(" ") === key.join(" "));
    if (clash || key.length === 0) key = [...new Set(tokenize(it.name).map(singular).filter((w) => w.length >= 2 && w !== "the"))];
    keys.set(it.item, key);
  }
  return keys;
}

/** Item-name words with a digit in them, which are read as names, not numbers. */
export function nameNumberWords(items: readonly QuoteItem[]): Set<string> {
  return new Set(items.flatMap((it) => tokenize(it.name).filter((w) => /\d/.test(w))));
}

/** Token positions where the item is mentioned: all its key words within a few words of each other. */
function mentions(tokens: string[], key: string[]): number[] {
  if (key.length === 0) return [];
  const words = tokens.map(singular);
  const out: number[] = [];
  for (let p = 0; p < words.length; p++) {
    if (words[p] !== key[0] && !key.includes(words[p]!)) continue;
    const window = words.slice(Math.max(0, p - 4), p + 5);
    if (key.every((k) => window.includes(k)) && !out.some((q) => Math.abs(q - p) <= 4)) out.push(p);
  }
  return out;
}

function findTokens(hay: string[], needle: string[]): number {
  if (needle.length === 0) return -1;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export type Verdict = { ok: true; message: number; at: number } | { ok: false; reason: string };

export type QuoteContext = {
  items: readonly QuoteItem[];
  said: readonly string[];
  /** Quotes already accepted: "message:at" -> item. */
  used: Map<string, number>;
};

export function checkQuote(ctx: QuoteContext, item: QuoteItem, naira: number, quote: string): Verdict {
  const no = (reason: string): Verdict => ({ ok: false, reason });
  const keys = itemKeys(ctx.items);
  const key = keys.get(item.item)!;
  if (ctx.items.some((o) => o.item !== item.item && keys.get(o.item)!.join(" ") === key.join(" "))) {
    return no("another item has the same name, so the trader must say which one");
  }

  const nameWords = nameNumberWords(ctx.items);
  const q = readSpoken(quote, nameWords);
  if (q.tokens.length === 0) return no("quote must be the trader's exact words from the transcript");
  if (q.unreadable.length > 0) return no("the number in the quote can't be read safely (a letter inside a number)");
  const values = [...new Set(q.prices.map((p) => p.value))];
  if (values.length === 0) return no("the quote has no price in it; quote the trader's words that say the price");
  if (values.length > 1) return no("the quote has more than one price; a range or a choice is not a price, so ask the trader");
  if (values[0] !== naira) return no(`price_naira ${naira} doesn't match the price in the quote (${values[0]})`);

  const messages = ctx.said.map((t) => readSpoken(t, nameWords));
  let m = -1;
  let at = -1;
  for (let i = messages.length - 1; i >= 0 && m < 0; i--) {
    const found = findTokens(messages[i]!.tokens, q.tokens);
    if (found >= 0) (m = i), (at = found);
  }
  if (m < 0) return no("quote must be the trader's exact words from the transcript");
  const msg = messages[m]!;
  const end = at + q.tokens.length;

  // This item's stretch runs from where the trader names it (before the price,
  // or inside the quote) to the next item they name after the price.
  const quoted = msg.prices.find((p) => p.at >= at && p.at < end)!;
  const others = ctx.items.filter((o) => o.item !== item.item).flatMap((o) => mentions(msg.tokens, keys.get(o.item)!));
  const unitWord = item.unit ? singular(item.unit.split(" ")[0]!) : undefined;
  let from = Math.max(-1, ...mentions(msg.tokens, key).filter((p) => p < end));
  if (from < 0) {
    // "all the tins 800": a group word, then the item's unit, before the price.
    const g = msg.tokens.findIndex((w, i) => GROUP_WORDS.has(w) && i <= quoted.at);
    const unitSaid = unitWord !== undefined && g >= 0 && msg.tokens.slice(g, quoted.at).map(singular).includes(unitWord);
    if (!unitSaid) return no("the quote's part of the message doesn't name this item");
    from = g;
  }
  if (others.some((p) => p > from && p <= quoted.at)) return no("the quote is about another item");
  const to = Math.min(msg.tokens.length, ...others.filter((p) => p > quoted.at));
  const stretch = msg.tokens.slice(from, to);
  const group = stretch.some((w) => GROUP_WORDS.has(w));
  if (msg.unreadable.some((p) => p >= from && p < to)) return no("a number near the quote can't be read safely, so ask the trader");

  // The quote's price must be the trader's last word on the item.
  const near = msg.prices.filter((p) => p.at >= from && p.at < to && p.value !== quoted.value);
  if (near.some((p) => p.at > quoted.at)) return no("the trader gave another price for this item after the quote; ask which is right");
  const lastOther = Math.max(-1, ...near.map((p) => p.at));
  if (lastOther >= 0 && !msg.tokens.slice(lastOther + 1, quoted.at).some((w) => CORRECTIONS.has(w))) {
    return no("the trader gave two prices for this item; a range or a choice is not a price, so ask the trader");
  }
  if (stretch.some((w, i) => RANGE_WORDS.has(w) && msg.prices.some((p) => p.at >= from && p.at < to && Math.abs(p.at - (from + i)) <= 2 && p.value !== quoted.value))) {
    return no("a range or a choice is not a price, so ask the trader");
  }
  for (let i = m + 1; i < messages.length; i++) {
    const later = messages[i]!;
    for (const p of mentions(later.tokens, key)) {
      const otherAfter = ctx.items.filter((o) => o.item !== item.item).flatMap((o) => mentions(later.tokens, keys.get(o.item)!)).filter((x) => x > p);
      const stop = Math.min(later.tokens.length, ...otherAfter);
      if (later.prices.some((pr) => pr.at > p && pr.at < stop) || later.unreadable.some((u) => u > p && u < stop)) {
        return no("a later message prices this item again; use the latest");
      }
    }
  }

  const span = `${m}:${at}`;
  const prior = ctx.used.get(span);
  if (prior !== undefined && prior !== item.item && !group) return no("that quote was already used for another item");
  return { ok: true, message: m, at };
}
