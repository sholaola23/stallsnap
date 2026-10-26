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
import { PhotoError, type Photo, preparePhoto } from "../pipeline/photo.ts";
import type { PricingResult } from "../pipeline/pricing.ts";
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
const YES = /^(yes|yes publish|yes,? publish|yeah|ok|okay|publish|correct|na so|confam|go ahead|👍)$/i;

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
};

type Input = Session["inputs"][number];

export class Conversation {
  readonly #o: Required<ConversationOptions>;

  constructor(o: ConversationOptions) {
    this.#o = { newJobId: () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...o };
  }

  async handle(msg: Inbound): Promise<void> {
    const { store } = this.#o;
    let s = store.get(msg.from);

    // Handling is serial, so these phases at the start mean a crash cut the work off.
    const resuming = s?.phase === "working" || s?.phase === "publishing";
    if (s?.phase === "working") await this.#work(s, msg.id);
    else if (s?.phase === "publishing") await this.#publish(s);
    s = store.get(msg.from);
    if (s && seen(s, msg.id)) {
      // A message handled before arrives again only when a crash stopped its
      // handling from being recorded. Whatever it last sent may never have
      // left, so send it again (the work itself comes back from the job log).
      if (!resuming) await this.#resend(s);
      return;
    }

    const kind = msg.kind === "audio" ? "voice" : msg.kind;
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
      if (s.phase === "confirming" && msg.replyId === confirmId(s)) return this.#publish(s);
      return void (await this.#say(s.trader, copy.staleButton));
    }
    if (msg.kind === "text" && s.phase === "confirming" && YES.test(msg.text.trim().replace(/[.!]+$/, ""))) return this.#publish(s);
    if (msg.kind !== "text" && msg.kind !== "voice" && msg.kind !== "audio") return;

    if (s.phase === "confirming" && s.changes >= MAX_CHANGES) return void (await this.#say(s.trader, copy.tooManyChanges));
    if (s.inputs.length >= MAX_INPUTS) return void (await this.#say(s.trader, copy.tooManyChanges));
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
    store.save(s);
    if (firstRun) await this.#say(s.trader, copy.working);
    await messenger.typing(triggerId);
    const typing = setInterval(() => void messenger.typing(triggerId), TYPING_EVERY_MS);
    try {
      if (firstRun) {
        const photo = s.photo!;
        let items: Item[];
        try {
          items = await log.step(s.jobId, `cutouts:${photo.messageId}`, () => this.#cutouts(s, photo));
        } catch (e) {
          if (!(e instanceof PhotoError || e instanceof MediaError)) throw e;
          s.photo = null;
          s.phase = "collecting";
          store.save(s);
          return void (await this.#say(s.trader, traderMessage(e)));
        }
        if (items.length === 0) {
          s.phase = "failed";
          store.save(s);
          log.failJob(s.jobId, "no products found");
          return void (await this.#say(s.trader, copy.noProducts));
        }
        s.items = items;
        store.save(s);
      }

      const said: string[] = [];
      for (const input of s.inputs) {
        if (input.kind === "text") {
          said.push(input.text);
          continue;
        }
        try {
          said.push(await this.#transcript(s, input));
        } catch (e) {
          if (!(e instanceof VoiceNoteError || e instanceof MediaError)) throw e;
          s.inputs = s.inputs.filter((i) => i.messageId !== input.messageId);
          if (back === "asking") s.askRounds--;
          if (back === "confirming") s.changes--;
          s.phase = back;
          store.save(s);
          return void (await this.#say(s.trader, traderMessage(e)));
        }
      }

      const version = s.version + 1;
      const result = await log.step(s.jobId, `pricing:v${version}`, () => this.#o.models.price(s.jobId, s.items.map(({ item, name }) => ({ item, name })), said));
      s.lines = result.lines;
      s.version = version;
      if (s.askRounds === 0 && s.changes === 0 && s.lines.some((l) => !l.price)) {
        s.phase = "asking";
        store.save(s);
        return void (await this.#say(s.trader, copy.questions(s.lines)));
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

  async #transcript(s: Session, input: Extract<Input, { kind: "voice" }>): Promise<string> {
    return this.#o.log.step(s.jobId, `transcript:${input.messageId}`, async () => {
      const { bytes } = await this.#o.messenger.download(input.mediaId, AUDIO_TYPES);
      return this.#o.models.transcribe(s.jobId, await this.#o.models.toWav(bytes), s.items.map((i) => i.name));
    });
  }

  async #sendList(s: Session): Promise<void> {
    const body = copy.list(s.lines);
    const button = { id: confirmId(s), title: copy.publishButton };
    if (body.length <= 1024) return void (await this.#o.messenger.sendButton(s.trader, body, button));
    await this.#say(s.trader, body);
    await this.#o.messenger.sendButton(s.trader, "Tap Yes, publish to put this list online.", button);
  }

  async #publish(s: Session): Promise<void> {
    const { store, log } = this.#o;
    s.phase = "publishing";
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
    await this.#say(s.trader, e instanceof SpendRefused ? copy.paused : copy.failed);
  }

  async #resend(s: Session): Promise<void> {
    if (s.phase === "confirming") await this.#sendList(s);
    else if (s.phase === "asking") await this.#say(s.trader, copy.questions(s.lines));
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

/** Reads a saved cut-out, for the catalogue page. */
export const readItemPng = (item: Item) => new Uint8Array(readFileSync(item.file));
