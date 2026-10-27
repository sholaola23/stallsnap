// One short, polite reply to someone who isn't a trader, such as a customer who
// tapped "Message on WhatsApp" on the demo catalogue. At most once per number
// every 24 hours, with no model calls. Only a hash of the number and the time
// are kept, never the message.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const STRANGER_GAP_MS = 24 * 60 * 60 * 1000;

const hash = (number: string) => createHash("sha256").update(`stallsnap-stranger:${number}`).digest("hex");

export class StrangerReplies {
  #path: string;
  #now: () => number;
  #last: Map<string, number>;

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
    let saved: unknown = {};
    try {
      if (existsSync(path)) saved = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      saved = {}; // a damaged file only means someone may get the reply once more
    }
    const entries = saved !== null && typeof saved === "object" && !Array.isArray(saved) ? Object.entries(saved) : [];
    this.#last = new Map(entries.filter((e): e is [string, number] => typeof e[1] === "number"));
  }

  /** True when this number should get the reply now; records it before the send, so a crash never sends twice. */
  claim(number: string): boolean {
    const now = this.#now();
    for (const [k, t] of this.#last) if (now - t >= STRANGER_GAP_MS) this.#last.delete(k);
    const key = hash(number);
    if (this.#last.has(key)) return false;
    this.#last.set(key, now);
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(`${this.#path}.tmp`, JSON.stringify(Object.fromEntries(this.#last)));
    renameSync(`${this.#path}.tmp`, this.#path);
    return true;
  }
}
