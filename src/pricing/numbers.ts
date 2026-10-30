// Reads the numbers in a trader's words, written ("1,500", "2k", "N800") or spoken
// ("five hundred", "two thousand five hundred", "one k"), so the price guard can check them.

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

// Words, numbers ("1,500", "1.5") and nothing else. "N800" gives "n" and "800"; "2k" gives "2" and "k".
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|[\p{L}']+/gu) ?? [];
}

// The same words, each with the clause it is in. Clauses end at punctuation followed by a space
// or the end ("Peak 500, Milo 1500" is two clauses; "1,500" and "1.5k" are not split).
export function clauseTokens(text: string): { words: string[]; clause: number[] } {
  const words: string[] = [];
  const clause: number[] = [];
  text.split(/[,.;:!?]+(?=\s|$)|\n/).forEach((part, i) => {
    for (const word of tokens(part)) {
      words.push(word);
      clause.push(i);
    }
  });
  return { words, clause };
}

export function isNumberWord(word: string | undefined): boolean {
  return word !== undefined && kindOf(word) !== null;
}

export interface NumberSpan {
  start: number; // token index
  end: number; // exclusive
  values: number[]; // what the words can mean; "two thousand five" is 2005 or, as traders say it, 2500
  quantity: boolean; // "two for 1000" or "N800 for two": the smaller is how many, not a price
}

type Kind = "digit" | "unit" | "teen" | "ten" | "scale";

function kindOf(token: string): Kind | null {
  if (/^\d/.test(token)) return "digit";
  if (token in UNITS) return "unit";
  if (token in TEENS) return "teen";
  if (token in TENS) return "ten";
  if (token === "hundred" || token === "thousand" || token === "k" || token === "million") return "scale";
  return null;
}

export function numberSpans(words: readonly string[]): NumberSpan[] {
  const spans: NumberSpan[] = [];
  let i = 0;
  while (i < words.length) {
    const first = kindOf(words[i]!);
    // A span starts with a value, never a bare "k" or "hundred".
    if (first === null || first === "scale") {
      i += 1;
      continue;
    }
    const start = i;
    let total = 0;
    let current = 0;
    let last: Kind | null = null;
    let afterThousand = false;
    let tail: number | null = null; // a lone 1-9 straight after "thousand"
    while (i < words.length) {
      const word = words[i]!;
      let kind = kindOf(word);
      // "one thousand and five hundred"
      if (word === "and" && last === "scale" && i + 1 < words.length && kindOf(words[i + 1]!) !== null) {
        i += 1;
        continue;
      }
      if (kind === null) break;
      if (kind === "scale") {
        if (last === "scale" && word !== "thousand" && word !== "k" && word !== "million") break;
        if (word === "hundred") current = (current || 1) * 100;
        else {
          const scale = word === "million" ? 1_000_000 : 1000;
          total += (current || 1) * scale;
          current = 0;
          afterThousand = scale === 1000;
        }
        tail = null;
      } else {
        // A new value can follow a scale ("thousand five") or join a ten ("twenty five"); otherwise a new number starts.
        const joins = last === null || last === "scale" || (last === "ten" && kind === "unit");
        if (!joins) break;
        const value = kind === "digit" ? Number(word.replace(/,/g, "")) : (UNITS[word] ?? TEENS[word] ?? TENS[word])!;
        tail = afterThousand && last === "scale" && value >= 1 && value <= 9 ? value : null;
        current += value;
        afterThousand = false;
      }
      last = kind;
      i += 1;
    }
    const value = Math.round(total + current);
    const values = tail !== null ? [value, Math.round(total + tail * 100)] : [value];
    spans.push({ start, end: i, values, quantity: false });
  }
  for (let k = 0; k + 1 < spans.length; k++) {
    const [a, b] = [spans[k]!, spans[k + 1]!];
    if (words[a.end] === "for" && b.start === a.end + 1) (a.values[0]! < b.values[0]! ? a : b).quantity = true;
  }
  return spans;
}

// Every number a quote can mean. Kept for the CLI and older tests.
export function numbersIn(quote: string): number[] {
  return numberSpans(tokens(quote)).flatMap((s) => s.values);
}
