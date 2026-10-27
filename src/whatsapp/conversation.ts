// The trader's conversation: photo and voice note in, one priced list with a
// single "Yes, publish" button out, then the catalogue link.
//
//   collecting  waiting for a photo and at least one voice note or text
//   working     cutting out, transcribing and pricing (paid steps)
//   asking      some items have no price: the trader is asked once
//   confirming  the one priced list is showing, with one button
//   publishing  building the catalogue page
//   published   link sent; a new photo starts a new catalogue
//   failed      something broke; a new photo starts again
//
// Every paid step runs through JobLog.step, so a webhook Meta sends twice, or
// a restart, never pays for the same step again. Handling is one message at a
// time, so finding a session still "working" means a crash cut it off: the
// work is run again, and finished steps come back from the log for free.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JobLog, StepInterrupted } from "../joblog.ts";
import { MAX_ATTEMPTS } from "../meta/client.ts";
import { PhotoError, type Photo, preparePhoto } from "../pipeline/photo.ts";
import { MAX_TURNS, type PricingResult } from "../pipeline/pricing.ts";
import { readSpoken } from "../pipeline/quotes.ts";
import { VoiceNoteError, type Wav } from "../pipeline/voice.ts";
import { SpendRefused } from "../spend-guard.ts";
import { copy } from "./copy.ts";
import type { GraphClient } from "./graph.ts";
import { MediaError } from "./graph.ts";
import type { Inbound } from "./parse.ts";
import { type Item, type Phase, type Session, type SessionStore, newSession } from "./sessions.ts";

export const MAX_INPUTS = 10;
export const MAX_CHANGES = 5;
export const PHOTO_TYPES = { mimeTypes: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024 };
export const AUDIO_TYPES = { mimeTypes: ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr"], maxBytes: 16 * 1024 * 1024 };
const TYPING_EVERY_MS = 20_000;
/** Most paid calls each step can make, retries included. A step only starts if the job can afford it. */
export const WORST_CALLS = { transcript: MAX_ATTEMPTS, pricing: MAX_TURNS * MAX_ATTEMPTS } as const;
/** Older than this, the trader's 24-hour reply window has probably closed, so no paid work starts. */
export const MAX_MESSAGE_AGE_MS = 23 * 60 * 60 * 1000;
const YES_WORD = "(yes|yeah|yep|ok|okay|publish|publish it|correct|confirm|confirmed|na so|confam|go ahead|oya|sure|done|go)";
const YES = new RegExp(`^(👍+|${YES_WORD}( ${YES_WORD})*( (please|pls|o|oh|sir|ma|👍+))*)$`, "u");

/** True when a text means "publish": "Yes please", "ok o", "👍🏾", "Yes, publish it!". */
export function isYes(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, "") // skin tones, emoji style
    .replace(/👍/g, " 👍 ")
    .replace(/[,.!]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/👍 (?=👍)/gu, "👍");
  return YES.test(t);
}

export type Messenger = Pick<GraphClient, "sendText" | "sendButton" | "sendLink" | "typing" | "download">;

/** The model steps, injected so tests can run without Meta. */
export type Models = {
  toWav(audio: Uint8Array): Promise<Wav>;
  cutouts(jobId: string, photo: Photo): Promise<{ name: string; png: Uint8Array }[]>;
  transcribe(jobId: string, wav: Wav, itemNames: readonly string[]): Promise<string>;
  price(jobId: string, items: readonly { item: number; name: string }[], said: readonly string[]): Promise<PricingResult>;
};

/** Builds and serves the public page; returns its URL. */
export type Publisher = (s: Session) => Promise<string>;

export type ConversationOptions = {
  store: SessionStore;
  log: JobLog;
  messenger: Messenger;
  models: Models;
  publish: Publisher;
  dataDir: string;
  newJobId?: () => string;
  now?: () => number;
  /** Paid calls the job may still make (SpendGuard's per-job cap minus calls made). */
  callsLeft?: (jobId: string) => number;
};

type Input = Session["inputs"][number];

export class Conversation {
  readonly #o: Required<ConversationOptions>;

  constructor(o: ConversationOptions) {
    this.#o = { newJobId: () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, now: () => Date.now(), ...o, callsLeft: o.callsLeft ?? (() => Number.POSITIVE_INFINITY) };
  }

  async handle(msg: Inbound): Promise<void> {
    const { store } = this.#o;
    let s = store.get(msg.from);

    // Handling is serial, so these phases at the start mean a crash cut the work off.
    const resuming = s?.phase === "working" || s?.phase === "publishing";
    if (s?.phase === "working") await this.#work(s, s.trigger ?? msg.id);
    else if (s?.phase === "publishing") await this.#publish(s, s.trigger ?? msg.id);
    // The replayed message that started the cut-off work is now fully handled.
    if (resuming && s?.trigger === msg.id) return;
    s = store.get(msg.from);
    if (s && seen(s, msg.id)) {
      // A message handled before arrives again only when a crash stopped its
      // handling from being recorded. Whatever it last sent may never have
      // left, so send it again (the work itself comes back from the job log).
      if (!resuming) await this.#resend(s);
      return;
    }

    if (this.#o.now() - msg.timestamp * 1000 > MAX_MESSAGE_AGE_MS) {
      // Meta retries for days. A reply this late would be refused, so nothing paid starts.
      return void console.log(`Skipped message ${msg.id}: older than 23 hours`);
    }

    const kind = msg.kind === "audio" ? "voice" : msg.kind;
    if (msg.kind === "other" && msg.type === "reaction") {
      if (s?.phase === "confirming") return void (await this.#say(msg.from, copy.tapToPublish));
      return;
    }
    if (kind === "other") return void (await this.#say(msg.from, copy.unsupported));

    if (!s || s.phase === "published" || s.phase === "failed") {
      if (kind === "image" || kind === "voice") {
        s = newSession(msg.from, this.#o.newJobId());
        this.#o.log.openJob(s.jobId);
      } else {
        return void (await this.#say(msg.from, s?.phase === "published" && s.url ? copy.alreadyPublished(s.url) : copy.welcome));
      }
    }

    switch (s.phase) {
      case "collecting":
        return this.#collect(s, msg);
      case "asking":
      case "confirming":
        return this.#reply(s, msg);
    }
  }

  async #collect(s: Session, msg: Inbound): Promise<void> {
    if (msg.kind === "image") {
      if (s.photo) {
        this.#o.store.save(s);
        return void (await this.#say(s.trader, copy.onePhoto));
      }
      s.photo = { messageId: msg.id, mediaId: msg.mediaId, mimeType: msg.mimeType };
      if (msg.caption) s.inputs.push({ messageId: `${msg.id}:caption`, kind: "text", text: msg.caption });
    } else if (msg.kind === "voice" || msg.kind === "audio") {
      s.inputs.push({ messageId: msg.id, kind: "voice", mediaId: msg.mediaId, mimeType: msg.mimeType });
    } else if (msg.kind === "text") {
      s.inputs.push({ messageId: msg.id, kind: "text", text: msg.text });
    } else if (msg.kind === "button") {
      // A button from an earlier list, tapped after a new photo started this one.
      this.#o.store.save(s);
      return void (await this.#say(s.trader, s.photo ? copy.oldListAfterPhoto : copy.staleButton));
    } else {
      this.#o.store.save(s);
      return void (await this.#say(s.trader, copy.welcome));
    }
    this.#o.store.save(s);

    if (s.photo && s.inputs.length > 0) return this.#work(s, msg.id);
    if (s.photo && msg.kind === "image") return void (await this.#say(s.trader, copy.photoThenVoice));
    if (!s.photo && (msg.kind === "voice" || msg.kind === "audio")) return void (await this.#say(s.trader, copy.voiceThenPhoto));
    if (!s.photo) return void (await this.#say(s.trader, copy.welcome));
  }

  async #reply(s: Session, msg: Inbound): Promise<void> {
    const { store } = this.#o;
    if (msg.kind === "image") {
      // A new photo starts a new catalogue.
      this.#o.log.failJob(s.jobId, "replaced by a new photo");
      const fresh = newSession(s.trader, this.#o.newJobId());
      this.#o.log.openJob(fresh.jobId);
      return this.#collect(fresh, msg);
    }
    if (msg.kind === "button") {
      if (s.phase === "confirming" && msg.replyId === confirmId(s)) return this.#publish(s, msg.id);
      return void (await this.#say(s.trader, copy.staleButton));
    }
    if (msg.kind === "text" && s.phase === "confirming" && isYes(msg.text)) return this.#publish(s, msg.id);
    if (msg.kind !== "text" && msg.kind !== "voice" && msg.kind !== "audio") return;

    // A text with no number in it ("thanks", "ok then") can't change a price, so nothing is paid for.
    if (msg.kind === "text" && s.phase === "confirming" && !hasNumber(msg.text)) return void (await this.#say(s.trader, copy.changeHint(s.lines)));
    if (s.phase === "confirming" && s.changes >= MAX_CHANGES) return void (await this.#say(s.trader, copy.tooManyChanges));
    if (s.inputs.length >= MAX_INPUTS) return void (await this.#say(s.trader, copy.tooManyChanges));
    const needed = WORST_CALLS.pricing + (msg.kind === "text" ? 0 : WORST_CALLS.transcript);
    if (this.#o.callsLeft(s.jobId) < needed) return void (await this.#say(s.trader, copy.tooManyChanges));
    s.inputs.push(msg.kind === "text" ? { messageId: msg.id, kind: "text", text: msg.text } : { messageId: msg.id, kind: "voice", mediaId: msg.mediaId, mimeType: msg.mimeType });
    const back = s.phase;
    if (back === "asking") s.askRounds++;
    else s.changes++;
    store.save(s);
    return this.#work(s, msg.id, back);
  }

  /**
   * Runs (or resumes) the paid steps for the current inputs, then asks or shows
   * the list. `back` is where the trader returns if one of their own files
   * can't be used, so they can simply send it again.
   */
  async #work(s: Session, triggerId: string, back: Phase = "collecting"): Promise<void> {
    const { log, store, messenger } = this.#o;
    const firstRun = s.items.length === 0;
    s.phase = "working";
    s.trigger = triggerId;
    store.save(s);
    if (firstRun) await this.#say(s.trader, copy.working);
    await messenger.typing(triggerId);
    const typing = setInterval(() => void messenger.typing(triggerId), TYPING_EVERY_MS);
    try {
      if (firstRun) {
        const photo = s.photo!;
        // A photo the trader can fix by resending is a saved answer, not a failed step, so the job stays open.
        const found = await log.step(s.jobId, `cutouts:${photo.messageId}`, () => orTell(() => this.#cutouts(s, photo)));
        if ("tell" in found) {
          s.photo = null;
          s.phase = "collecting";
          store.save(s);
          return void (await this.#say(s.trader, found.tell));
        }
        const items = found.ok;
        if (items.length === 0) {
          s.phase = "failed";
          store.save(s);
          log.failJob(s.jobId, "no products found");
          return void (await this.#say(s.trader, copy.noProducts));
        }
        s.items = items;
        store.save(s);
      }

      // The job must be able to afford every paid step still to come, so the per-job cap is never hit mid-way.
      const unheard = s.inputs.filter((i) => i.kind === "voice" && !(s.heard ?? []).includes(i.messageId)).length;
      if (this.#o.callsLeft(s.jobId) < WORST_CALLS.pricing + unheard * WORST_CALLS.transcript) {
        if (firstRun) {
          s.phase = "failed";
          store.save(s);
          log.failJob(s.jobId, "per-job call budget too small for the remaining steps");
          return void (await this.#say(s.trader, copy.jobTooBig));
        }
        s.inputs = s.inputs.filter((i) => i.messageId !== triggerId);
        if (back === "asking") s.askRounds--;
        if (back === "confirming") s.changes--;
        s.phase = back;
        store.save(s);
        return void (await this.#say(s.trader, copy.tooManyChanges));
      }

      const said: string[] = [];
      for (const input of s.inputs) {
        if (input.kind === "text") {
          said.push(input.text);
          continue;
        }
        const heard = await this.#transcript(s, input);
        if ("ok" in heard) {
          said.push(heard.ok);
          if (!(s.heard ?? []).includes(input.messageId)) s.heard = [...(s.heard ?? []), input.messageId];
        } else {
          s.inputs = s.inputs.filter((i) => i.messageId !== input.messageId);
          if (back === "asking") s.askRounds--;
          if (back === "confirming") s.changes--;
          s.phase = back;
          store.save(s);
          return void (await this.#say(s.trader, heard.tell));
        }
      }

      // A voice note after the list with no number in it ("thank you") changes nothing, so pricing isn't paid for again.
      const latest = s.inputs.at(-1);
      if (back === "confirming" && latest?.messageId === triggerId && latest.kind === "voice" && !hasNumber(said.at(-1) ?? "")) {
        s.inputs = s.inputs.slice(0, -1);
        s.changes--;
        s.phase = back;
        store.save(s);
        return void (await this.#say(s.trader, copy.changeHint(s.lines)));
      }

      const version = s.version + 1;
      const result = await log.step(s.jobId, `pricing:v${version}`, () => this.#o.models.price(s.jobId, s.items.map(({ item, name }) => ({ item, name })), said));
      s.lines = result.lines;
      s.unlisted = result.unlisted ?? [];
      s.version = version;
      s.listSent = 0;
      if (s.askRounds === 0 && s.changes === 0 && s.lines.some((l) => !l.price)) {
        s.phase = "asking";
        store.save(s);
        return void (await this.#say(s.trader, copy.questions(s.lines, s.unlisted)));
      }
      s.phase = "confirming";
      store.save(s);
      await this.#sendList(s);
    } catch (e) {
      await this.#fail(s, e);
    } finally {
      clearInterval(typing);
    }
  }

  async #cutouts(s: Session, photo: NonNullable<Session["photo"]>): Promise<Item[]> {
    const { bytes } = await this.#o.messenger.download(photo.mediaId, PHOTO_TYPES);
    const prepared = await preparePhoto(bytes);
    const found = await this.#o.models.cutouts(s.jobId, prepared);
    const dir = join(this.#o.dataDir, "jobs", s.jobId);
    mkdirSync(dir, { recursive: true });
    return found.map((c, i): Item => {
      const file = join(dir, `item-${i + 1}.png`);
      writeFileSync(file, c.png);
      return { item: i + 1, name: c.name, file };
    });
  }

  async #transcript(s: Session, input: Extract<Input, { kind: "voice" }>): Promise<Told<string>> {
    return this.#o.log.step(s.jobId, `transcript:${input.messageId}`, () =>
      orTell(async () => {
        const { bytes } = await this.#o.messenger.download(input.mediaId, AUDIO_TYPES);
        return this.#o.models.transcribe(s.jobId, await this.#o.models.toWav(bytes), s.items.map((i) => i.name));
      }),
    );
  }

  /**
   * Sends the list parts that haven't gone out yet for this version. Each part
   * is recorded once sent, so a replay after a crash between a long list's
   * text and its button sends only the button.
   */
  async #sendList(s: Session): Promise<void> {
    const body = copy.list(s.lines, s.unlisted);
    const button = { id: confirmId(s), title: copy.publishButton };
    const parts: (() => Promise<unknown>)[] =
      body.length <= 1024
        ? [() => this.#o.messenger.sendButton(s.trader, body, button)]
        : [() => this.#say(s.trader, body), () => this.#o.messenger.sendButton(s.trader, copy.tapToPublish, button)];
    for (let i = s.listSent ?? 0; i < parts.length; i++) {
      await parts[i]!();
      s.listSent = i + 1;
      this.#o.store.save(s);
    }
  }

  async #publish(s: Session, triggerId: string): Promise<void> {
    const { store, log } = this.#o;
    s.phase = "publishing";
    s.trigger = triggerId;
    store.save(s);
    try {
      const url = await this.#o.publish(s);
      s.url = url;
      s.phase = "published";
      store.save(s);
      log.finishJob(s.jobId);
      await this.#o.messenger.sendLink(s.trader, copy.published(url), copy.openButton, url);
    } catch (e) {
      await this.#fail(s, e);
    }
  }

  /** Anything the trader can't fix by resending ends the job; they start again with a new photo. */
  async #fail(s: Session, e: unknown): Promise<void> {
    s.phase = "failed";
    this.#o.store.save(s);
    this.#o.log.failJob(s.jobId, e instanceof Error ? e.message : String(e));
    if (!(e instanceof SpendRefused || e instanceof StepInterrupted)) console.error(`Job ${s.jobId} failed:`, e instanceof Error ? e.message : e);
    await this.#say(s.trader, e instanceof SpendRefused ? refusalMessage(e) : copy.failed);
  }

  async #resend(s: Session): Promise<void> {
    if (s.phase === "confirming") await this.#sendList(s);
    else if (s.phase === "asking") await this.#say(s.trader, copy.questions(s.lines, s.unlisted));
    else if (s.phase === "published" && s.url) await this.#o.messenger.sendLink(s.trader, copy.published(s.url), copy.openButton, s.url);
  }

  async #say(to: string, text: string): Promise<void> {
    await this.#o.messenger.sendText(to, text);
  }
}

export const confirmId = (s: Session) => `publish:${s.jobId}:v${s.version}`;

function seen(s: Session, id: string): boolean {
  return s.photo?.messageId === id || s.inputs.some((i) => i.messageId === id);
}

/** What the trader is told when SpendGuard refuses a call, by reason. */
function refusalMessage(e: SpendRefused): string {
  if (e.reason === "daily-cap") return copy.dailyCap;
  if (e.reason === "job-call-cap") return copy.jobTooBig;
  return copy.paused; // switched off, or the ledger can't be read
}

/** True when the text has a price-like number in it, even an unreadable one. */
const hasNumber = (text: string) => {
  const r = readSpoken(text);
  return r.prices.length > 0 || r.unreadable.length > 0 || /\d/.test(text);
};

function traderMessage(e: unknown): string {
  if (e instanceof PhotoError) return e.message;
  if (e instanceof VoiceNoteError) {
    if (e.reason === "too-long") return "That voice note is longer than 10 minutes. Please send a shorter one.";
    if (e.reason === "empty") return "I couldn't hear any words in that voice note. Please send it again.";
    return "I couldn't play that voice note. Please record it again in WhatsApp.";
  }
  if (e instanceof MediaError) {
    if (e.reason === "too-big") return "That file is too big. Please send a normal WhatsApp photo or voice note.";
    if (e.reason === "wrong-type") return "I can't open that type of file. Please send a normal WhatsApp photo or voice note.";
    return "I couldn't download that. Please send it again.";
  }
  return copy.failed;
}

type Told<T> = { ok: T } | { tell: string };

/** Runs `run`; a problem the trader can fix by resending becomes the message to tell them. */
async function orTell<T>(run: () => Promise<T>): Promise<Told<T>> {
  try {
    return { ok: await run() };
  } catch (e) {
    if (e instanceof PhotoError || e instanceof VoiceNoteError || e instanceof MediaError) return { tell: traderMessage(e) };
    throw e;
  }
}

/** Reads a saved cut-out, for the catalogue page. */
export const readItemPng = (item: Item) => new Uint8Array(readFileSync(item.file));
