// A test harness for the conversation: fake WhatsApp, fake models, real job
// log and session store on disk. A fake voice note's bytes are its transcript.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { JobLog } from "../joblog.ts";
import type { Line, PricingResult } from "../pipeline/pricing.ts";
import { VoiceNoteError } from "../pipeline/voice.ts";
import { Conversation, type Models } from "./conversation.ts";
import { MediaError } from "./graph.ts";
import type { Inbound } from "./parse.ts";
import { SessionStore } from "./sessions.ts";

export const TRADER = "447700900123";
export type Sent = { kind: "text" | "button" | "link" | "typing"; to?: string; body?: string; id?: string; url?: string };

let jpeg: Uint8Array | undefined;
export async function photoBytes(): Promise<Uint8Array> {
  jpeg ??= new Uint8Array(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#c84" } }).jpeg().toBuffer());
  return jpeg;
}

let n = 0;
export const msg = {
  photo: (mediaId = "photo-1", extra: Partial<Inbound> = {}): Inbound => ({ id: `wamid.${++n}`, from: TRADER, timestamp: n, phoneNumberId: "p", kind: "image", mediaId, mimeType: "image/jpeg", ...extra }) as Inbound,
  voice: (mediaId: string): Inbound => ({ id: `wamid.${++n}`, from: TRADER, timestamp: n, phoneNumberId: "p", kind: "voice", mediaId, mimeType: "audio/ogg" }),
  text: (text: string): Inbound => ({ id: `wamid.${++n}`, from: TRADER, timestamp: n, phoneNumberId: "p", kind: "text", text }),
  button: (replyId: string): Inbound => ({ id: `wamid.${++n}`, from: TRADER, timestamp: n, phoneNumberId: "p", kind: "button", replyId, title: "Yes, publish" }),
  other: (type = "sticker"): Inbound => ({ id: `wamid.${++n}`, from: TRADER, timestamp: n, phoneNumberId: "p", kind: "other", type }),
};

/** Prices each item whose name the trader said with a number after "na". */
export function sayPrices(items: readonly { item: number; name: string }[], said: readonly string[]): PricingResult {
  const text = said.join(" ").toLowerCase();
  const lines: Line[] = items.map((i) => {
    // The last price said wins, as with the real pricing step.
    const all = [...text.matchAll(new RegExp(`(?:${i.name.toLowerCase()}|\\b${i.item}) na (\\d+)(?![\\w])`, "g"))];
    const m = all.at(-1);
    return m ? { item: i.item, name: i.name, price: { naira: Number(m[1]), unit: "piece", quote: m[0] }, question: null } : { item: i.item, name: i.name, price: null, question: `How much is ${i.name}?` };
  });
  return { lines, events: [], turns: 1, stopped: "all-done" };
}

export function harness(opts: { dir?: string; products?: string[]; models?: Partial<Models>; media?: Record<string, Uint8Array | Error>; hang?: Partial<Record<"sendButton" | "price" | "publish", boolean>>; now?: () => number; callsLeft?: () => number } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "conv-"));
  const sent: Sent[] = [];
  const calls = { cutouts: 0, transcribe: 0, price: 0, publish: 0 };
  const media: Record<string, Uint8Array | Error> = { ...opts.media };
  const log = new JobLog(join(dir, "joblog.jsonl"));
  const store = new SessionStore(join(dir, "sessions.json"));
  const never = new Promise<never>(() => {});

  const messenger = {
    sendText: async (to: string, body: string) => (sent.push({ kind: "text", to, body }), "w"),
    sendButton: async (to: string, body: string, b: { id: string; title: string }) => {
      if (opts.hang?.sendButton) return never;
      sent.push({ kind: "button", to, body, id: b.id });
      return "w";
    },
    sendLink: async (to: string, body: string, _t: string, url: string) => (sent.push({ kind: "link", to, body, url }), "w"),
    typing: async () => void sent.push({ kind: "typing" }),
    download: async (mediaId: string) => {
      const m = media[mediaId] ?? (mediaId.startsWith("photo") ? await photoBytes() : new TextEncoder().encode(mediaId));
      if (m instanceof Error) throw m;
      return { bytes: m, mimeType: "x" };
    },
  };
  const models: Models = {
    toWav: async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      if (text === "silence") throw new VoiceNoteError("empty", "No speech");
      return { bytes, durationMs: 1000 };
    },
    cutouts: async () => (calls.cutouts++, (opts.products ?? ["Rice", "Garri"]).map((name) => ({ name, png: new Uint8Array([1, 2, 3]) }))),
    transcribe: async (_j, wav) => (calls.transcribe++, new TextDecoder().decode(wav.bytes)),
    price: async (_j, items, said) => {
      calls.price++;
      if (opts.hang?.price) return never;
      return sayPrices(items, said);
    },
    ...opts.models,
  };
  const conversation = new Conversation({
    store,
    log,
    messenger,
    models,
    dataDir: dir,
    publish: async (s) => (calls.publish++, opts.hang?.publish ? never : `https://stall.test/c/${s.jobId}`),
    // Test messages carry small timestamps (1, 2, 3 seconds), so "now" is just after them.
    now: opts.now ?? (() => 1_000_000),
    callsLeft: opts.callsLeft,
  });
  const texts = () => sent.filter((s) => s.kind !== "typing").map((s) => s.body ?? "");
  const last = () => sent.filter((s) => s.kind !== "typing").at(-1)!;
  return { conversation, sent, calls, store, log, dir, media, texts, last, cleanup: () => (log.close(), rmSync(dir, { recursive: true, force: true })), close: () => log.close() };
}

export { MediaError };
