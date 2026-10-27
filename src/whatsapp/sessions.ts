// One session per trader: where their current catalogue job is up to.
// Kept in a JSON file, written atomically after every change, so a restart
// picks up where each trader was. It holds phone numbers, so it lives in
// .data/, which is kept out of git.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Line } from "../pipeline/pricing.ts";

export type Phase = "collecting" | "working" | "asking" | "confirming" | "publishing" | "published" | "failed";

export type Media = { messageId: string; mediaId: string; mimeType: string };

export type Item = { item: number; name: string; file: string };

export type Session = {
  trader: string;
  jobId: string;
  phase: Phase;
  photo: Media | null;
  /** Voice notes and texts with prices or changes, in the order they arrived. */
  inputs: ({ messageId: string; kind: "voice"; mediaId: string; mimeType: string } | { messageId: string; kind: "text"; text: string })[];
  items: Item[];
  lines: Line[];
  version: number;
  askRounds: number;
  changes: number;
  url: string | null;
  /** The message that started the current working or publishing phase, so a replay of it after a crash isn't handled twice. */
  trigger?: string;
  /** How many parts of the current list version went out (a long list is a text and then a button). */
  listSent?: number;
  /** Voice notes already transcribed, so their paid step is known to be done. */
  heard?: string[];
};

export function newSession(trader: string, jobId: string): Session {
  return { trader, jobId, phase: "collecting", photo: null, inputs: [], items: [], lines: [], version: 0, askRounds: 0, changes: 0, url: null };
}

export class SessionStore {
  readonly #path: string;
  readonly #sessions: Map<string, Session>;

  constructor(path: string) {
    this.#path = path;
    this.#sessions = new Map();
    if (existsSync(path)) {
      // A damaged file stops start-up rather than silently forgetting every trader.
      const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, Session>;
      for (const [k, v] of Object.entries(data)) this.#sessions.set(k, v);
    }
  }

  get(trader: string): Session | undefined {
    return this.#sessions.get(trader);
  }

  save(s: Session): void {
    this.#sessions.set(s.trader, s);
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(`${this.#path}.tmp`, JSON.stringify(Object.fromEntries(this.#sessions)));
    renameSync(`${this.#path}.tmp`, this.#path);
  }
}
