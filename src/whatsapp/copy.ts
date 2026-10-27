// Every message StallSnap sends a trader. UK English, plain words, no dashes
// as punctuation. StallSnap is a catalogue builder, not a chatbot: it answers
// anything off-topic with what it does.
import type { Line } from "../pipeline/pricing.ts";

const naira = (n: number) => `₦${n.toLocaleString("en-GB")}`;

/** An example change the pricing step accepts: the first item by name, then a price ("rice na 1500"). */
export const changeExample = (lines: readonly Line[]) => `${(lines[0]?.name ?? "rice").toLowerCase()} na 1500`;

export const copy = {
  welcome:
    "Welcome to StallSnap. I build a price catalogue for your stall that you can share.\n\n1. Send a photo of your stall.\n2. Send a voice note saying your prices.\n\nI only make catalogues, so I can't help with other questions.",
  photoThenVoice: "Photo received. Now send a voice note saying your prices.",
  voiceThenPhoto: "Voice note received. Now send a photo of your stall.",
  onePhoto: "I use one photo for each catalogue, so I kept your first photo. To start again with a new photo, send it after your catalogue is ready.",
  working: "Thank you! I am making your price list now. This takes about a minute.",
  stillWorking: "I am still working on your list. I will reply soon.",
  noProducts: "I couldn't find any products in that photo. Please send a photo of your whole stall, taken in good light.",
  unsupported: "I can read photos, voice notes and text messages only.",
  staleButton: "That list has changed since. Please tap the button on the newest list.",
  oldListAfterPhoto: "That list is from your old photo. Now send a voice note saying your prices for the new one.",
  tapToPublish: "To put it online, tap Yes, publish on the list.",
  tooManyChanges: "That is a lot of changes. Please tap Yes, publish on the newest list, or send a new photo to start again.",
  paused: "StallSnap is paused for now. Please try again later.",
  dailyCap: "StallSnap has reached today's limit, so it is paused until tomorrow. Please send your photo and voice note again then.",
  jobTooBig: "That photo needed more checking than one catalogue allows, so I stopped there. Please send a photo with fewer items, then your voice note again.",
  failed: "Sorry, something went wrong while I was making your list. Please send your photo and voice note again.",
  publishing: "Putting your catalogue online...",
  publishButton: "Yes, publish",
  openButton: "Open catalogue",

  /** One line for each item the trader priced that isn't in the photo, in their own words. */
  notInPhoto(names: readonly string[]): string[] {
    return names.map((name) => `You mentioned ${name}, send a photo of it.`);
  },

  questions(lines: readonly Line[], unlisted: readonly string[] = []): string {
    const asks = lines.filter((l) => !l.price);
    return [
      `I found ${lines.length} ${lines.length === 1 ? "item" : "items"}. I need ${asks.length === 1 ? "a price" : "prices"} for:`,
      ...asks.map((l) => `${l.item}. ${l.name}: ${l.question}`),
      ...(unlisted.length ? ["", ...copy.notInPhoto(unlisted)] : []),
      "",
      "Send a voice note or a text with the prices.",
    ].join("\n");
  },

  /** The one priced list. It goes above the single Yes, publish button. */
  list(lines: readonly Line[], unlisted: readonly string[] = []): string {
    return [
      "Here is your price list:",
      ...lines.map((l) => `${l.item}. ${l.name}: ${l.price ? `${naira(l.price.naira)} per ${l.price.unit}` : "ask for price"}`),
      ...(unlisted.length ? ["", ...copy.notInPhoto(unlisted)] : []),
      "",
      `Tap Yes, publish to put it online. To change a price, send a voice note or a text, like "${changeExample(lines)}".`,
    ].join("\n");
  },

  /** For a text after the list that has no price in it, such as "thanks". */
  changeHint(lines: readonly Line[]): string {
    return `To change a price, send the item and its new price, like "${changeExample(lines)}". To put your list online, tap Yes, publish.`;
  },

  published(url: string): string {
    return `Your catalogue is online. Share this link with your customers:\n${url}`;
  },

  alreadyPublished(url: string): string {
    return `Your catalogue is at ${url}\n\nTo make a new one, send a new photo of your stall.`;
  },
};
