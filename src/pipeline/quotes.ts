// The quote verifier: decides, in code, whether what the trader said supports
// one price for one item. Spark's set_price call is accepted only when this
// says yes. It is an allow-list: a price counts only when the trader's words
// take one plain shape, and anything else is asked about. A question to the
// trader is fine; a wrong price never is.
//
// Each message is split at the listed items' names. A name is said when a run
// of that item's own name words includes all the words that pick it out
// ("peak milk", "50kg rice", "5 alive"). The words after it, up to the next
// item, must be exactly:
//   [filler words] [na | is | for | at | =] PRICE
//   then any number of: [filler] CORRECTION... [na | is ...] PRICE   (the last one wins)
//   then only "naira", "per <word>" or filler words
// PRICE is one number: digits or number words, an optional N/₦ or "naira",
// and an optional k / thousand / hundred ("5 hundred", "2 thousand 5 hundred",
// "2.5k", "2k5", "1.8" for 1,800). A number with a letter in it is unreadable.
// A number before the first item, a range, "each", "bags of", two prices
// without a correction, or any other shape makes the item's price unclear.
//
// Spark's quote must sit inside the item's latest priced part of the
// conversation and give exactly that price.

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, tousand: 1000, million: 1_000_000 };
const THOUSAND_WORDS = new Set(["k", "thousand", "tousand"]);
// Not "abeg": in Pidgin it is mostly "please" ("abeg buy"), so it can't mark a correction.
const CORRECTIONS = new Set(["no", "sorry", "mean", "correction", "wait"]);
const RANGE_WORDS = new Set(["to", "or", "abi", "between"]);
/** Words that describe packaging or size, not which product an item is. */
const GENERIC = new Set([
  "piece", "pack", "packet", "sachet", "tin", "bottle", "can", "bag", "carton", "crate", "cup", "paint", "bucket", "basin", "kg",
  "litre", "yard", "strip", "tuber", "bunch", "heap", "dozen", "roll", "pair", "set", "loaf", "tray", "small", "big", "large",
  "medium", "the", "and", "of", "with", "for", "per", "one", "new",
]);

export type Price = { value: number; at: number };
/** `masked`: positions that are part of an item's name ("400g", or the "5" in "5 alive"), never numbers. */
export type Spoken = { tokens: string[]; prices: Price[]; unreadable: number[]; masked: number[] };

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
 * Reads every price in `text`. Words that are provably part of an item's name are not numbers:
 * - a word with digits and letters from any item's name ("400g", "50kg", "7up", "3-in-1"), which can never be a price;
 * - a bare number from a name ("5" in "5 Alive", "30" in "Eggs 30") only where that item's whole name is said, in order.
 * Anything else that looks like a number is one, so a doubtful reading is asked about, never guessed.
 */
export function readSpoken(text: string, items: readonly { name: string }[] = []): Spoken {
  const tokens = tokenize(text);
  let prices: Price[] = [];
  const unreadable: number[] = [];
  const numbers: { at: number; end: number }[] = []; // every number, small ones too, for finding ranges
  const masked = maskNames(tokens, items);
  for (let i = 0; i < tokens.length; ) {
    if (masked.has(i)) {
      i++;
      continue;
    }
    const d = hundreds(tokens, i) ?? digitValue(tokens[i]!, tokens[i + 1]);
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
  return { tokens, prices, unreadable, masked: [...masked].sort((x, y) => x - y) };
}

/** "5 hundred" is 500, and "2 hundred and 50" or "2 hundred and fifty" is 250. Only a whole number under 100 counts. */
function hundreds(tokens: string[], i: number): { value: number; consumed: number } | undefined {
  const t = tokens[i]!;
  if (!/^\d{1,2}$/.test(t) || tokens[i + 1] !== "hundred") return undefined;
  let value = Number(t) * 100;
  let consumed = 2;
  if (tokens[i + 2] === "and") {
    const rest = tokens[i + 3];
    const digit = rest !== undefined && /^\d{1,2}$/.test(rest) ? Number(rest) : undefined;
    const word = digit === undefined ? wordValue(tokens, i + 3) : undefined;
    const add = digit ?? (word && word.value < 100 ? word.value : undefined);
    if (add !== undefined) {
      value += add;
      consumed += 2 + (word ? word.consumed - 1 : 0);
    }
  }
  return { value, consumed };
}

function maskNames(tokens: string[], items: readonly { name: string }[]): Set<number> {
  const masked = new Set<number>();
  const mixed = new Set(items.flatMap((it) => tokenize(it.name).filter((w) => /\d/.test(w) && /\p{L}/u.test(w))));
  tokens.forEach((w, i) => mixed.has(w) && masked.add(i));
  for (const it of items) {
    const name = tokenize(it.name);
    if (!name.some((w) => /^\d+$/.test(w))) continue;
    for (let i = 0; i + name.length <= tokens.length; i++) {
      if (name.every((w, j) => singular(tokens[i + j]!) === singular(w))) name.forEach((w, j) => /^\d+$/.test(w) && masked.add(i + j));
    }
  }
  return masked;
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

export type Verdict = { ok: true; message: number; at: number } | { ok: false; reason: string };

export type QuoteContext = {
  items: readonly QuoteItem[];
  said: readonly string[];
  /** Quotes already accepted: "message:at" -> item. */
  used: Map<string, number>;
};

const CONNECTORS = new Set(["na", "is", "for", "at", "be"]);
/** Words that may sit around a price without changing it. */
const FILLERS = new Set(["the", "a", "my", "dey", "don", "now", "o", "oh", "abeg", "sef", "e", "just", "only", "it", "its", "price"]);
/** Selling words before a price: "rice go for 1500", "we dey sell for 1500". */
const SELLING = new Set(["go", "we", "i", "sell", "sells", "selling", "cost", "costs"]);
/** Words joining one item's price to the next item: "rice na 1500 and garri na 900". */
const JOINERS = new Set(["and", "then", "plus", "but", "while", "also"]);
/** Packaging and size words: "rice crate na 5-8", "one cup", "for one paint". */
const PACK = new Set([...GENERIC].filter((w) => !["the", "and", "of", "with", "for", "per", "one", "new"].includes(w)));
const ONE = new Set(["one", "1", "a", "an"]);
const isNumberToken = (w: string) => /\d/.test(w) || w in NUMBER_WORDS || w in SCALES;

/**
 * One price expression starting at `i`, parsed as a whole: its value and the position after it, or
 * undefined when it can't be read exactly. Digits and number words chain with multipliers, as said:
 * "5 hundred thousand" is 500,000, "3 thousand 5 hundred" and "3k 5 hundred" are 3,500,
 * "2 hundred and 50" is 250. Single-token forms: "2k5", "2.5k", "1.8" (1,800), "1.500", "5-8".
 */
function parsePrice(tokens: string[], i: number, limit = tokens.length): { value: number; end: number } | undefined {
  let j = i;
  if (tokens[j] === "n" && /^\d/.test(tokens[j + 1] ?? "")) j++; // "N 500"
  const first = tokens[j]?.replace(/^n(?=\d)/, "");
  if (first === undefined) return undefined;
  const withNaira = (value: number, end: number) => ({ value, end: end < limit && tokens[end] === "naira" ? end + 1 : end });
  const k5 = /^(\d{1,3})k(\d)$/.exec(first);
  if (k5) return withNaira(Number(k5[1]) * 1000 + Number(k5[2]) * 100, j + 1);
  if (/^\d+\.\d+k?$/.test(first) || /^\d-\d$/.test(first)) {
    if (tokens[j + 1] === "hundred") return undefined; // "1.5 hundred": unclear
    const d = digitValue(first, tokens[j + 1]);
    return d && d !== "unreadable" ? withNaira(d.value, j + d.consumed) : undefined;
  }
  // A strict chain of groups and multipliers. A group is a number, optionally "<n> hundred" (n under
  // 100) and then "and"/nothing plus a number under 100. Million, then thousand (or k), each at most
  // once and in that order. A group after a multiplier must use "hundred": "3 thousand 5" and "3k 500"
  // are not exact. Anything else ("2k 3k", "5 hundred 6 hundred", "1 hundred hundred") is undefined.
  let total = 0;
  let group: number | undefined;
  let hundred = false; // this group has its "hundred"
  let tail = false; // a number already follows the hundred
  let tens = false; // the last word was twenty..ninety, so "five" may follow
  let lastBig = Infinity;
  let small = true; // a lone word under ten ("one") isn't a price
  const start = j;
  const big = (value: number) => {
    total += group! * value;
    lastBig = value;
    group = undefined;
    hundred = tail = tens = false;
    small = false;
  };
  for (;;) {
    const t = j >= limit ? undefined : j === start ? first : tokens[j];
    if (t === undefined) break;
    const m = /^(\d+)(k)?$/.exec(t);
    if (m && (group === undefined || (hundred && !tail && !m[2] && Number(m[1]) < 100))) {
      if (m[2] && lastBig <= 1000) break;
      if (group === undefined) group = Number(m[1]);
      else (group += Number(m[1])), (tail = true);
      small = tens = false;
      j++;
      if (m[2]) big(1000);
      continue;
    }
    const w = NUMBER_WORDS[t];
    if (w !== undefined && (group === undefined || (hundred && !tail && w < 100) || (tens && w < 10))) {
      if (group === undefined) group = w;
      else (group += w), (tail = tail || hundred);
      if (w >= 10) small = false;
      tens = w >= 20 && w % 10 === 0 && !tens;
      j++;
      continue;
    }
    if (t === "hundred" && group !== undefined && !hundred && group >= 1 && group < 100) {
      group *= 100;
      hundred = true;
      small = tens = false;
      j++;
      continue;
    }
    const scale = THOUSAND_WORDS.has(t) ? 1000 : t === "million" ? 1_000_000 : undefined;
    if (scale !== undefined && group !== undefined && scale < lastBig) {
      big(scale);
      j++;
      continue;
    }
    // "2 hundred and 50": "and" continues a number only straight after "hundred".
    const next = tokens[j + 1] ?? "";
    if (t === "and" && hundred && !tail && tokens[j - 1] === "hundred" && (/^\d{1,2}$/.test(next) || next in NUMBER_WORDS)) {
      j++;
      continue;
    }
    break;
  }
  if (small || (group === undefined && lastBig === Infinity)) return undefined;
  if (group !== undefined && lastBig !== Infinity && !hundred) return undefined; // "3 thousand 5", "3k 500"
  if (j < limit && isNumberToken(tokens[j]!)) return undefined; // a letter inside a number, or a second number
  return withNaira(total + (group ?? 0), j);
}

type Segment = { item: number; start: number; end: number; price?: { value: number; from: number; to: number }; unclear?: string };

/** Splits one message at the listed items' names, and reads each item's price if it has the one plain shape. */
export function segments(text: string, items: readonly QuoteItem[]): { tokens: string[]; segments: Segment[] } {
  const tokens = tokenize(text);
  const words = tokens.map(singular);
  const keys = itemKeys(items);
  const nameSets = new Map(items.map((it) => [it.item, new Set(tokenize(it.name).map(singular))]));
  // Find name runs: the longest run of one item's own name words that contains all its key words.
  const runs: { item: number; start: number; end: number }[] = [];
  for (let p = 0; p < words.length; ) {
    let best: { item: number; end: number } | undefined;
    let tie = false;
    for (const it of items) {
      const set = nameSets.get(it.item)!;
      let e = p;
      while (e < words.length && set.has(words[e]!)) e++;
      const run = words.slice(p, e);
      if (e === p || !keys.get(it.item)!.every((k) => run.includes(k))) continue;
      if (!best || e > best.end) (best = { item: it.item, end: e }), (tie = false);
      else if (e === best.end) tie = true;
    }
    if (best && !tie) {
      runs.push({ item: best.item, start: p, end: best.end });
      p = best.end;
    } else p++;
  }
  const out: Segment[] = runs.map((r, n) => ({ item: r.item, start: r.start, end: n + 1 < runs.length ? runs[n + 1]!.start : tokens.length }));
  type Body = { price?: Segment["price"]; unclear?: string };
  // Reads the words after one item's name, up to `end`. Undefined when they hold no number ("rice dey").
  const parseBody = (nameEnd: number, end: number, hasNext: boolean): Body | undefined => {
    if (!tokens.slice(nameEnd, end).some(isNumberToken)) return undefined;
    let j = nameEnd;
    // Filler and packaging words, and "one cup" / "a bag" (a quantity of one is never unclear).
    const skip = () => {
      for (;;) {
        if (j < end && (FILLERS.has(tokens[j]!) || PACK.has(singular(tokens[j]!)))) j++;
        else if (j + 1 < end && ONE.has(tokens[j]!) && PACK.has(singular(tokens[j + 1]!))) j += 2;
        else return;
      }
    };
    // Filler, selling words and connectors, in any order: "go for", "dey sell for", "na for".
    const lead = () => {
      for (;;) {
        skip();
        if (j < end && (CONNECTORS.has(tokens[j]!) || SELLING.has(tokens[j]!))) j++;
        else return;
      }
    };
    lead();
    let price = parsePrice(tokens, j, end);
    if (!price || price.end > end) return { unclear: "the words after the item aren't one plain price" };
    let found = { value: price.value, from: j, to: price.end };
    j = price.end;
    for (;;) {
      skip();
      if (!CORRECTIONS.has(tokens[j]!) && !(tokens[j] === "i" && tokens[j + 1] === "mean")) break;
      while (j < end && (CORRECTIONS.has(tokens[j]!) || tokens[j] === "i")) j++;
      lead();
      price = parsePrice(tokens, j, end);
      if (!price || price.end > end) return { unclear: "a correction without one plain new price" };
      found = { value: price.value, from: j, to: price.end };
      j = price.end;
    }
    // Only "naira", "per <unit>", "for one <unit>", filler or packaging words, and a joiner before the next item may follow.
    while (j < end) {
      if (FILLERS.has(tokens[j]!) || PACK.has(singular(tokens[j]!)) || tokens[j] === "naira") j++;
      else if (JOINERS.has(tokens[j]!) && hasNext && tokens.slice(j + 1, end).every((w) => FILLERS.has(w) || JOINERS.has(w))) j++;
      else if (tokens[j] === "per" && j + 1 < end && !isNumberToken(tokens[j + 1]!)) j += 2;
      else if (tokens[j] === "for" && j + 2 < end && ONE.has(tokens[j + 1]!) && !isNumberToken(tokens[j + 2]!)) j += 3;
      else return { unclear: `"${tokens.slice(found.to, end).join(" ")}" after the price makes it unclear` };
    }
    return { price: found };
  };
  const apply = (seg: Segment, body: Body | undefined) => {
    seg.price = body?.price;
    seg.unclear = body?.unclear;
  };
  out.forEach((seg, n) => apply(seg, parseBody(runs[n]!.end, seg.end, n + 1 < out.length)));
  const has = (seg: Segment) => seg.price !== undefined || seg.unclear !== undefined;

  // A number before the first item: a quantity, or a price said before the name.
  if (out[0] && has(out[0]) && tokens.slice(0, out[0].start).some(isNumberToken)) out[0].unclear = "a number before the item (a quantity?) makes the price unclear";
  let reversed = false;
  for (let n = 1; n < out.length; n++) {
    const prev = out[n - 1]!;
    const seg = out[n]!;
    const between = tokens.slice(runs[n - 1]!.end, runs[n]!.start);
    // "rice and beans na 3000", "rice, beans na 3000": two names before one price. Both are asked.
    if (has(seg) && between.every((w) => JOINERS.has(w) || w === "or")) {
      prev.price = seg.price = undefined;
      prev.unclear = seg.unclear = "two items named before one price; ask which price is for which";
      continue;
    }
    // Look back past up to three packaging words and "of": "2 bags of beans".
    let before = runs[n]!.start - 1;
    while (before > runs[n]!.start - 4 && before >= runs[n - 1]!.end && (PACK.has(singular(tokens[before]!)) || tokens[before] === "of")) before--;
    if (before < runs[n - 1]!.end || !isNumberToken(tokens[before]!)) continue;
    if (!has(seg)) {
      // "3000 beans" with nothing after the name: prices come before names in this message.
      reversed = true;
      continue;
    }
    // Was that number the previous item's price ("rice 3000 beans 3500"), or a quantity for this one
    // ("rice 3000, 2 beans 3500")? If the previous item has a price without it, it's a quantity.
    // A number with packaging words before the name ("2 bags of beans") is always a quantity.
    const trimmed = parseBody(runs[n - 1]!.end, before, true);
    if (trimmed?.price || before < runs[n]!.start - 1) {
      apply(prev, trimmed);
      seg.price = undefined;
      seg.unclear = "a number straight before the item (a quantity?) makes the price unclear";
    }
  }
  if (reversed) {
    for (const seg of out) {
      if (has(seg) || tokens.slice(seg.start, seg.end).some(isNumberToken)) {
        seg.price = undefined;
        seg.unclear = "prices and names come in a different order in this message, so ask which price is for which";
      }
    }
  }
  return { tokens, segments: out };
}

function findAll(hay: string[], needle: string[]): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    out.push(i);
  }
  return out;
}

export function checkQuote(ctx: QuoteContext, item: QuoteItem, naira: number, quote: string): Verdict {
  const no = (reason: string): Verdict => ({ ok: false, reason });
  const keys = itemKeys(ctx.items);
  const key = keys.get(item.item)!;
  if (ctx.items.some((o) => o.item !== item.item && keys.get(o.item)!.join(" ") === key.join(" "))) {
    return no("another item has the same name, so the trader must say which one");
  }
  const q = tokenize(quote);
  if (q.length === 0) return no("quote must be the trader's exact words from the transcript");
  const parsed = ctx.said.map((t) => segments(t, ctx.items));
  if (!parsed.some((p) => findAll(p.tokens, q).length > 0)) return no("quote must be the trader's exact words from the transcript");

  // The trader's latest words on this item that have a number in them decide.
  for (let m = parsed.length - 1; m >= 0; m--) {
    const segs = parsed[m]!.segments.filter((s) => s.item === item.item && (s.price || s.unclear));
    if (segs.length === 0) continue;
    if (segs.length > 1) return no("the trader named this item twice with prices in one message; ask which is right");
    const seg = segs[0]!;
    if (seg.unclear) return no(`${seg.unclear}, so ask the trader`);
    const p = seg.price!;
    if (p.value !== naira) return no(`the trader's price for this item is ${p.value}, not ${naira}`);
    const inside = findAll(parsed[m]!.tokens, q).filter((at) => at >= seg.start && at + q.length <= seg.end && at <= p.from && at + q.length >= p.to);
    if (inside.length === 0) return no("quote the trader's own words for this item, including its latest price");
    const at = inside[0]!;
    const prior = ctx.used.get(`${m}:${at}`);
    if (prior !== undefined && prior !== item.item) return no("that quote was already used for another item");
    return { ok: true, message: m, at };
  }
  return no("the trader hasn't said a price for this item by name; ask the trader");
}
