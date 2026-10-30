// The WhatsApp conversation: photo, then voice note, then YES, then a catalogue link.
// One trader's messages are handled one at a time, in the order they arrive.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CatalogueStore } from "../catalogue/store.ts";
import { PhotoError } from "../image/photo.ts";
import { photoToCutouts } from "../image/pipeline.ts";
import type { MetaClient } from "../meta/client.ts";
import { SpendRefused } from "../meta/spend.ts";
import { priceNote, replyText, startPricing, type PricingState } from "../pricing/agent.ts";
import { transcribeNote, VoiceError } from "../voice/transcribe.ts";
import type { WhatsAppSender } from "./graph.ts";
import type { Incoming } from "./webhook.ts";

export const COPY = {
  welcome:
    "Welcome to StallSnap, the catalogue builder. Send one clear photo of your stall, then a voice note saying your prices. I'll send back a link to your price list.",
  working: "Got your photo. Picking out your goods now, this takes about a minute.",
  noProducts: "I couldn't pick out any goods in that photo. Please send a clearer photo, in good light, with the goods facing the camera.",
  photoFirst: "Please send a photo of your stall first, then the voice note with your prices.",
  unsupported: "I can read photos, voice notes and text. Please send one of those.",
  paused: "StallSnap is paused for a short while. Please try again later.",
  failed: "Sorry, something went wrong on my side. Please send that again.",
  nothingToPublish: "There's nothing to publish yet. Send a photo of your stall to start.",
  pricesFirst: "Send a voice note with your prices first, then reply YES.",
};

const YES = /^\s*(yes|yes o|yeah|yep|ok|okay|confirm|publish)\s*[.!]*\s*$/i;

interface Session {
  products: { id: number; name: string }[];
  pricing: PricingState | null;
  slug: string | null;
}

export interface BotOptions {
  client: MetaClient;
  sender: WhatsAppSender;
  store: CatalogueStore;
  dataDir: string;
  publicUrl: string; // e.g. https://stallsnap.up.railway.app
  stallName: string;
  allowedNumbers: ReadonlySet<string>;
  log?: (message: string) => void;
}

export function productListText(names: readonly string[]): string {
  return (
    `I found ${names.length} ${names.length === 1 ? "item" : "items"}:\n` +
    names.map((n, i) => `${i + 1}. ${n}`).join("\n") +
    "\n\nNow send a voice note saying the price of each one."
  );
}

export class Bot {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();

  constructor(private readonly options: BotOptions) {
    mkdirSync(join(options.dataDir, "sessions"), { recursive: true });
    const seenPath = join(options.dataDir, "seen.json");
    if (existsSync(seenPath)) for (const id of JSON.parse(readFileSync(seenPath, "utf8")) as string[]) this.seen.add(id);
  }

  // Returns at once; the work runs behind it, one message at a time per trader.
  receive(message: Incoming): Promise<void> {
    // Only verified test numbers are answered, before any paid call.
    if (!this.options.allowedNumbers.has(message.from)) {
      this.options.log?.("dropped a message from a number not on ALLOWED_NUMBERS");
      return Promise.resolve();
    }
    // Meta retries a webhook it thinks failed, so the same message can arrive twice.
    if (this.seen.has(message.id)) return Promise.resolve();
    this.seen.add(message.id);
    writeFileSync(join(this.options.dataDir, "seen.json"), JSON.stringify([...this.seen].slice(-1000)));

    const previous = this.queues.get(message.from) ?? Promise.resolve();
    const next = previous.then(() => this.handle(message)).catch((error) => this.options.log?.(`handler error: ${String(error)}`));
    this.queues.set(message.from, next);
    return next;
  }

  private sessionPath(from: string): string {
    // Phone numbers are not used as file names.
    return join(this.options.dataDir, "sessions", createHash("sha256").update(from).digest("hex").slice(0, 32));
  }

  private load(from: string): Session | null {
    const path = join(this.sessionPath(from), "session.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Session) : null;
  }

  private save(from: string, session: Session): void {
    mkdirSync(this.sessionPath(from), { recursive: true });
    writeFileSync(join(this.sessionPath(from), "session.json"), JSON.stringify(session));
  }

  private cards(from: string, session: Session): Map<number, Buffer> {
    const cards = new Map<number, Buffer>();
    for (const p of session.products) {
      const path = join(this.sessionPath(from), `card-${p.id}.jpg`);
      if (existsSync(path)) cards.set(p.id, readFileSync(path));
    }
    return cards;
  }

  private async handle(message: Incoming): Promise<void> {
    const say = (text: string) => this.options.sender.sendText(message.from, text);
    // STALLSNAP_MAX_CALLS caps each message; the daily dollar cap covers the whole server.
    const client = this.options.client.withBudget(this.options.client.budget.forJob());
    try {
      switch (message.kind) {
        case "image":
          return await this.onPhoto(client, message.from, message.mediaId, say);
        case "audio":
          return await this.onNote(client, message.from, say, { mediaId: message.mediaId });
        case "text":
          return await this.onText(client, message.from, message.text, say);
        default:
          return await say(COPY.unsupported);
      }
    } catch (error) {
      if (error instanceof PhotoError || error instanceof VoiceError) return await say(error.message);
      if (error instanceof SpendRefused) {
        this.options.log?.(error.message);
        return await say(COPY.paused);
      }
      this.options.log?.(`failed on a ${message.kind} message: ${error instanceof Error ? error.message : String(error)}`);
      await say(COPY.failed);
    }
  }

  private async onPhoto(client: MetaClient, from: string, mediaId: string, say: (t: string) => Promise<void>): Promise<void> {
    await say(COPY.working);
    const photo = await this.options.sender.download(mediaId);
    const result = await photoToCutouts(client, photo);
    if (result.cutouts.length === 0) return say(COPY.noProducts);
    // A new photo starts a new list but keeps the trader's link. Products are numbered 1..n as the
    // trader sees them, so "number 4" means the same product to the trader, the model and the page.
    const old = this.load(from);
    const session: Session = { products: result.cutouts.map((c, i) => ({ id: i + 1, name: c.name })), pricing: null, slug: old?.slug ?? null };
    mkdirSync(this.sessionPath(from), { recursive: true });
    result.cutouts.forEach((cut, i) => writeFileSync(join(this.sessionPath(from), `card-${i + 1}.jpg`), cut.card));
    this.save(from, session);
    await say(productListText(session.products.map((p) => p.name)));
  }

  private async onNote(client: MetaClient, from: string, say: (t: string) => Promise<void>, note: { mediaId?: string; text?: string }): Promise<void> {
    const session = this.load(from);
    if (!session) return say(COPY.photoFirst);
    const transcript =
      note.text ?? (await transcribeNote(client, await this.options.sender.download(note.mediaId!), session.products.map((p) => p.name)));
    session.pricing = await priceNote(client, session.pricing ?? startPricing(session.products), transcript);
    this.save(from, session);
    await say(replyText(session.pricing));
  }

  private async onText(client: MetaClient, from: string, text: string, say: (t: string) => Promise<void>): Promise<void> {
    const session = this.load(from);
    if (YES.test(text)) {
      if (!session?.pricing) return say(session ? COPY.pricesFirst : COPY.nothingToPublish);
      const catalogue = this.options.store.publish(session.pricing, this.cards(from, session), this.options.stallName, session.slug ?? undefined);
      session.slug = catalogue.slug;
      this.save(from, session);
      const link = `${this.options.publicUrl.replace(/\/$/, "")}/c/${catalogue.slug}`;
      return say(`Your price list is live: ${link}\n\nShare this link with your customers. Send a voice note any time to change a price, then reply YES again.`);
    }
    if (!session) return say(COPY.welcome);
    // Typed prices count the same as a voice note.
    return this.onNote(client, from, say, { text });
  }
}
