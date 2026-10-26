// Every message StallSnap sends a trader. UK English, plain words, no dashes
// as punctuation. StallSnap is a catalogue builder, not a chatbot: it answers
// anything off-topic with what it does.
import type { Line } from "../pipeline/pricing.ts";

const naira = (n: number) => `₦${n.toLocaleString("en-GB")}`;

export const copy = {
  welcome:
    "Welcome to StallSnap. I build a price catalogue for your stall that you can share.\n\n1. Send a photo of your stall.\n2. Send a voice note saying your prices.\n\nI only make catalogues, so I can't help with other questions.",
  photoThenVoice: "Photo received. Now send a voice note saying your prices.",
  voiceThenPhoto: "Voice note received. Now send a photo of your stall.",
  onePhoto: "I use one photo for each catalogue, so I kept your first photo. To start again with a new photo, send it after your catalogue is ready.",
  working: "Thank you! I am making your price list now. This takes about a minute.",
  stillWorking: "I am still working on your list. I will reply soon.",
  noProducts: "I couldn't find any products in that photo. Please send a clearer photo of your stall, taken in good light.",
  unsupported: "I can read photos, voice notes and text messages only.",
  staleButton: "That list has changed since. Please tap the button on the newest list.",
  tooManyChanges: "That is a lot of changes. Please tap Yes, publish on the newest list, or send a new photo to start again.",
  paused: "StallSnap is paused for now. Please try again later.",
  failed: "Sorry, something went wrong while I was making your list. Please send your photo and voice note again.",
  publishing: "Putting your catalogue online...",
  publishButton: "Yes, publish",
  openButton: "Open catalogue",

  questions(lines: readonly Line[]): string {
    const asks = lines.filter((l) => !l.price);
    return [
      `I found ${lines.length} ${lines.length === 1 ? "item" : "items"}. I need ${asks.length === 1 ? "a price" : "prices"} for:`,
      ...asks.map((l) => `${l.item}. ${l.name}: ${l.question}`),
      "",
      "Send a voice note or a text with the prices.",
    ].join("\n");
  },

  /** The one priced list. It goes above the single Yes, publish button. */
  list(lines: readonly Line[]): string {
    return [
      "Here is your price list:",
      ...lines.map((l) => `${l.item}. ${l.name}: ${l.price ? `${naira(l.price.naira)} per ${l.price.unit}` : "ask for price"}`),
      "",
      'Tap Yes, publish to put it online. To change something, send a voice note or a text, like "2 na 150".',
    ].join("\n");
  },

  published(url: string): string {
    return `Your catalogue is online. Share this link with your customers:\n${url}`;
  },

  alreadyPublished(url: string): string {
    return `Your catalogue is at ${url}\n\nTo make a new one, send a new photo of your stall.`;
  },
};
