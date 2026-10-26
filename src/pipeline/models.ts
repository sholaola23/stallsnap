// The real model steps for the conversation, all through one MetaClient
// (so every paid call goes through SpendGuard).
import type { MetaClient } from "../meta/client.ts";
import type { Models } from "../whatsapp/conversation.ts";
import { cutoutPng, findProducts } from "./cutouts.ts";
import { priceItems } from "./pricing.ts";
import { toWav, transcribe } from "./voice.ts";

export function realModels(client: MetaClient): Models {
  return {
    toWav,
    async cutouts(jobId, photo) {
      const found = await findProducts(client, jobId, photo);
      return Promise.all(found.map(async (c) => ({ name: c.name, png: await cutoutPng(photo, c.mask) })));
    },
    transcribe: (jobId, wav, names) => transcribe(client, jobId, wav, names),
    price: (jobId, items, said) => priceItems(client, jobId, items, said),
  };
}
