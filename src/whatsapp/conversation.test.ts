import { afterEach, describe, expect, test } from "bun:test";
import { SpendRefused } from "../spend-guard.ts";
import { copy } from "./copy.ts";
import { MediaError, TRADER, harness, msg, sayPrices } from "./test-conversation.ts";

let h: ReturnType<typeof harness>;
afterEach(() => h?.cleanup());

describe("the happy path", () => {
  test("photo, then voice note, then one priced list with one button, then the link", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    expect(h.last().body).toBe(copy.photoThenVoice);

    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    const list = h.last();
    expect(list.kind).toBe("button");
    expect(list.body).toBe(copy.list(h.store.get(TRADER)!.lines));
    expect(list.body).toContain("1. Rice: ₦6,000 per piece");
    expect(list.body).toContain("2. Garri: ₦1,500 per piece");
    expect(h.sent.filter((s) => s.kind === "button")).toHaveLength(1);
    expect(h.sent.some((s) => s.kind === "typing")).toBe(true);

    await h.conversation.handle(msg.button(list.id!));
    const link = h.last();
    expect(link.kind).toBe("link");
    expect(link.url).toStartWith("https://stall.test/c/job-");
    expect(link.body).toContain(link.url!);
    const s = h.store.get(TRADER)!;
    expect(s.phase).toBe("published");
    expect(h.log.job(s.jobId)?.status).toBe("done");
    expect(h.calls).toEqual({ cutouts: 1, transcribe: 1, price: 1, publish: 1 });
  });

  test("voice note first, then photo", async () => {
    h = harness();
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    expect(h.last().body).toBe(copy.voiceThenPhoto);
    await h.conversation.handle(msg.photo());
    expect(h.last().kind).toBe("button");
  });

  test("typed prices work like a voice note, and a typed yes publishes", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.text("Rice na 6000 garri na 1500"));
    expect(h.last().kind).toBe("button");
    await h.conversation.handle(msg.text("Yes!"));
    expect(h.last().kind).toBe("link");
  });

  test("a caption with prices counts as what the trader said", async () => {
    h = harness();
    await h.conversation.handle(msg.photo("photo-1", { caption: "rice na 6000 garri na 1500" } as never));
    expect(h.last().kind).toBe("button");
  });
});

describe("ask, never guess", () => {
  test("unpriced items are asked about first; the reply gives one list; anything still unpriced shows 'ask for price'", async () => {
    h = harness({ products: ["Rice", "Garri", "Beans"] });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000"));
    expect(h.last()).toMatchObject({ kind: "text", body: copy.questions(h.store.get(TRADER)!.lines) });
    expect(h.last().body).toContain("2. Garri: How much is Garri?");
    expect(h.sent.filter((s) => s.kind === "button")).toHaveLength(0);

    await h.conversation.handle(msg.text("garri na 1500"));
    const list = h.last();
    expect(list.kind).toBe("button");
    expect(list.body).toContain("2. Garri: ₦1,500 per piece");
    expect(list.body).toContain("3. Beans: ask for price");
  });
});

describe("changes after the list", () => {
  test("a change sends a new list; the old button no longer publishes", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    const v1 = h.last().id!;
    await h.conversation.handle(msg.text("rice na 6500"));
    const v2 = h.last();
    expect(v2.kind).toBe("button");
    expect(v2.id).not.toBe(v1);
    expect(v2.body).toContain("1. Rice: ₦6,500 per piece");

    await h.conversation.handle(msg.button(v1));
    expect(h.last().body).toBe(copy.staleButton);
    expect(h.calls.publish).toBe(0);
    await h.conversation.handle(msg.button(v2.id!));
    expect(h.last().kind).toBe("link");
  });

  test("after 5 changes the trader is asked to publish or start again", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    for (let i = 0; i < 5; i++) await h.conversation.handle(msg.text(`rice na ${6100 + i}`));
    const pricedBefore = h.calls.price;
    await h.conversation.handle(msg.text("rice na 7000"));
    expect(h.last().body).toBe(copy.tooManyChanges);
    expect(h.calls.price).toBe(pricedBefore);
  });

  test("a new photo while confirming starts a new catalogue", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    const first = h.store.get(TRADER)!.jobId;
    await h.conversation.handle(msg.photo("photo-2"));
    const s = h.store.get(TRADER)!;
    expect(s.jobId).not.toBe(first);
    expect(h.log.job(first)?.status).toBe("failed");
    expect(h.last().body).toBe(copy.photoThenVoice);
  });

  test("a long list goes as text, then the button", async () => {
    h = harness({ products: Array.from({ length: 30 }, (_, i) => `Item number ${i + 1} with a long name`) });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.text("nothing"));
    await h.conversation.handle(msg.text("still nothing"));
    const [listText, button] = h.sent.filter((s) => s.kind !== "typing").slice(-2);
    expect(listText!.kind).toBe("text");
    expect(listText!.body!.length).toBeGreaterThan(1024);
    expect(button!.kind).toBe("button");
  });
});

describe("not a catalogue message", () => {
  test("a greeting or off-topic question gets the welcome, which says StallSnap only makes catalogues", async () => {
    h = harness();
    await h.conversation.handle(msg.text("Hello, can you tell me a joke?"));
    expect(h.last().body).toBe(copy.welcome);
    expect(copy.welcome).toContain("I only make catalogues");
  });

  test("a sticker gets the 'photos, voice notes and text' reply", async () => {
    h = harness();
    await h.conversation.handle(msg.other());
    expect(h.last().body).toBe(copy.unsupported);
  });

  test("after publishing, a text gets the link again", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    await h.conversation.handle(msg.text("ok"));
    await h.conversation.handle(msg.text("thanks"));
    expect(h.last().body).toBe(copy.alreadyPublished(h.store.get(TRADER)!.url!));
  });
});

describe("things that go wrong", () => {
  test("no products found: the trader is told, and a new photo starts again", async () => {
    h = harness({ products: [] });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000"));
    expect(h.last().body).toBe(copy.noProducts);
    expect(h.store.get(TRADER)!.phase).toBe("failed");
  });

  test("a photo that can't be read is dropped; the next photo carries on with the same voice note", async () => {
    h = harness({ media: { "photo-bad": new TextEncoder().encode("not a jpeg") } });
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    await h.conversation.handle(msg.photo("photo-bad"));
    expect(h.last().body).toContain("couldn't be opened");
    await h.conversation.handle(msg.photo("photo-good"));
    expect(h.last().kind).toBe("button");
  });

  test("a voice note with no speech is dropped and the trader asked again; the next one works", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("silence"));
    expect(h.last().body).toContain("couldn't hear any words");
    expect(h.store.get(TRADER)!.phase).toBe("collecting");
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    expect(h.last().kind).toBe("button");
  });

  test("a voice note too big to download is refused with a plain reason", async () => {
    h = harness({ media: { big: new MediaError("too-big", "x") } });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("big"));
    expect(h.last().body).toContain("too big");
  });

  for (const [reason, said] of [
    ["daily-cap", copy.dailyCap],
    ["job-call-cap", copy.jobTooBig],
    ["paid-calls-off", copy.paused],
    ["ledger-unreadable", copy.paused],
  ] as const) {
    test(`a ${reason} refusal ends the job with an accurate message`, async () => {
      h = harness({ models: { cutouts: async () => Promise.reject(new SpendRefused(reason, "cap")) } });
      await h.conversation.handle(msg.photo());
      await h.conversation.handle(msg.voice("rice na 6000"));
      expect(h.last().body).toBe(said);
      expect(h.store.get(TRADER)!.phase).toBe("failed");
    });
  }
});

describe("restarts", () => {
  test("the same message handled twice (a replay after restart) does no paid work twice", async () => {
    h = harness();
    const photo = msg.photo();
    const voice = msg.voice("rice na 6000, garri na 1500");
    await h.conversation.handle(photo);
    await h.conversation.handle(voice);
    await h.conversation.handle(voice);
    expect(h.calls).toMatchObject({ cutouts: 1, transcribe: 1, price: 1 });
  });

  test("a crash while sending the list: after restart the list is sent without paying again", async () => {
    const first = harness({ hang: { sendButton: true } });
    const voice = msg.voice("rice na 6000, garri na 1500");
    await first.conversation.handle(msg.photo());
    void first.conversation.handle(voice); // never finishes: the process "dies" here
    await Bun.sleep(20);
    first.close();

    h = harness({ dir: first.dir });
    await h.conversation.handle(voice); // Meta's retry, or the job log's replay
    expect(h.last().kind).toBe("button");
    expect(h.calls).toMatchObject({ cutouts: 0, transcribe: 0, price: 0 });
  });

  test("a crash during a paid step: after restart the job fails cleanly and nothing is paid twice", async () => {
    const first = harness({ hang: { price: true } });
    const voice = msg.voice("rice na 6000, garri na 1500");
    await first.conversation.handle(msg.photo());
    void first.conversation.handle(voice);
    await Bun.sleep(20);
    first.close();

    h = harness({ dir: first.dir });
    await h.conversation.handle(voice);
    expect(h.last().body).toBe(copy.failed);
    expect(h.calls).toMatchObject({ cutouts: 0, transcribe: 0, price: 0 });
    expect(h.store.get(TRADER)!.phase).toBe("failed");

    await h.conversation.handle(msg.photo("photo-2"));
    expect(h.last().body).toBe(copy.photoThenVoice);
  });
});

describe("a price for an item not in the photo", () => {
  test("the list says \"You mentioned yam, send a photo of it.\", in the trader's words", async () => {
    h = harness({ models: { price: async (_j, items, said) => ({ ...sayPrices(items, said), unlisted: ["yam"] }) } });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500, yam na 2000"));
    const list = h.last();
    expect(list.kind).toBe("button");
    expect(list.body).toContain("You mentioned yam, send a photo of it.");
    expect(list.body).not.toContain("₦2,000");
  });
  test("the questions message says it too", async () => {
    h = harness({ models: { price: async (_j, items, said) => ({ ...sayPrices(items, said), unlisted: ["yam", "egusi"] }) } });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, yam na 2000, egusi na 900"));
    expect(h.last().body).toContain("You mentioned yam, send a photo of it.\nYou mentioned egusi, send a photo of it.");
    expect(h.last().body).toContain("Garri: How much is Garri?");
  });
  test("with nothing unlisted, the list is unchanged", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    expect(h.last().body).not.toContain("You mentioned");
  });
});
