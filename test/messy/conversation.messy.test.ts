// Messy-input suite: conversations that don't go in the tidy order.
import { afterEach, describe, expect, test } from "bun:test";
import { copy } from "../../src/whatsapp/copy.ts";
import { MAX_INPUTS, MAX_MESSAGE_AGE_MS, isYes } from "../../src/whatsapp/conversation.ts";
import { TRADER, harness, msg } from "../../src/whatsapp/test-conversation.ts";

let h: ReturnType<typeof harness>;
afterEach(() => {
  h?.cleanup();
  h = undefined as unknown as typeof h;
});

async function toList() {
  h = harness();
  await h.conversation.handle(msg.photo());
  await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
  return h.last().id!;
}

describe("buttons and yeses that must not publish", () => {
  test("a made-up button id", async () => {
    await toList();
    await h.conversation.handle(msg.button("publish:someone-else:v1"));
    expect(h.last().body).toBe(copy.staleButton);
    expect(h.calls.publish).toBe(0);
  });

  test("a button tap before any list exists", async () => {
    h = harness();
    await h.conversation.handle(msg.button("publish:job-1:v1"));
    expect(h.last().body).toBe(copy.welcome);
    expect(h.calls.publish).toBe(0);
  });

  test("a yes while StallSnap is still asking for prices is taken as an answer, not a publish", async () => {
    h = harness({ products: ["Rice", "Garri", "Beans"] });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000"));
    await h.conversation.handle(msg.text("yes"));
    expect(h.calls.publish).toBe(0);
    expect(h.last().kind).toBe("button");
  });

  for (const not of ["yes but rice na 7000", "yess", "no", "y", "publish later", "OK?"]) {
    test(`"${not}" is not a yes`, async () => {
      await toList();
      await h.conversation.handle(msg.text(not));
      expect(h.calls.publish).toBe(0);
    });
  }

  for (const yes of ["YES", "Yes, publish", "ok", "Okay.", "na so", "confam", "👍"]) {
    test(`"${yes}" is a yes`, async () => {
      await toList();
      await h.conversation.handle(msg.text(yes));
      expect(h.calls.publish).toBe(1);
    });
  }

  test("tapping Yes twice publishes once", async () => {
    const id = await toList();
    await h.conversation.handle(msg.button(id));
    await h.conversation.handle(msg.button(id));
    expect(h.calls.publish).toBe(1);
  });
});

describe("odd orders and amounts", () => {
  test("two photos in a row keep the first and say so", async () => {
    h = harness();
    await h.conversation.handle(msg.photo("photo-1"));
    await h.conversation.handle(msg.photo("photo-2"));
    expect(h.last().body).toBe(copy.onePhoto);
    expect(h.store.get(TRADER)!.photo!.mediaId).toBe("photo-1");
  });

  test("two traders at once never see each other's lists", async () => {
    h = harness();
    const other = (m: ReturnType<typeof msg.photo>) => ({ ...m, from: "2348000000001" });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(other(msg.photo()));
    await h.conversation.handle(other(msg.voice("rice na 100, garri na 200")));
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    const lists = h.sent.filter((s) => s.kind === "button");
    expect(lists.find((l) => l.to === TRADER)!.body).toContain("₦6,000");
    expect(lists.find((l) => l.to === "2348000000001")!.body).toContain("₦100");
  });

  test(`more than ${MAX_INPUTS} messages of prices stops paid work`, async () => {
    h = harness({ products: ["Rice", "Garri", "Beans"] });
    await h.conversation.handle(msg.photo());
    for (let i = 0; i < MAX_INPUTS + 3; i++) await h.conversation.handle(msg.text(`rice na ${6000 + i}`));
    expect(h.calls.price).toBeLessThanOrEqual(MAX_INPUTS);
    expect(h.last().body).toBe(copy.tooManyChanges);
  });

  test("placeholder prices are never published as numbers", async () => {
    h = harness();
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.text("rice na N/A, garri na ???"));
    expect(h.last().body).toContain("How much is Rice?");
    await h.conversation.handle(msg.text("rice na 6O00")); // letter O
    expect(h.last().body).toContain("1. Rice: ask for price");
  });

  test("an empty caption doesn't count as prices", async () => {
    h = harness();
    await h.conversation.handle(msg.photo("photo-1", { caption: "" } as never));
    expect(h.last().body).toBe(copy.photoThenVoice);
  });
});

// QA round 1 on PR #8: each attack is a permanent test.
describe("QA round 1 on PR #8", () => {
  test("B1: a crash inside publish(), then the tap replayed, sends exactly one link and nothing else", async () => {
    const first = harness({ hang: { publish: true } });
    await first.conversation.handle(msg.photo());
    await first.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    const tap = msg.button(first.last().id!);
    void first.conversation.handle(tap); // the process "dies" inside publish()
    await Bun.sleep(20);
    first.close();

    h = harness({ dir: first.dir });
    await h.conversation.handle(tap); // the job log's replay
    expect(h.sent.filter((x) => x.kind !== "typing").map((x) => x.kind)).toEqual(["link"]);
    expect(h.store.get(TRADER)!.phase).toBe("published");
  });

  test("B2: a crash between a long list's text and its button: the replay sends only the button", async () => {
    const products = Array.from({ length: 12 }, (_, i) => `Product number ${i + 1} with a long sixty character name xxxxxxxx`.slice(0, 60));
    const first = harness({ products, hang: { sendButton: true } });
    const voice = msg.voice(products.map((_, i) => `${i + 1} na 100`).join(", "));
    await first.conversation.handle(msg.photo());
    void first.conversation.handle(voice); // text sent, then the button never returns
    await Bun.sleep(20);
    first.close();
    const listTexts = (sent: { kind: string; body?: string }[]) => sent.filter((x) => x.kind === "text" && x.body?.startsWith("Here is your price list")).length;
    expect(listTexts(first.sent)).toBe(1);

    h = harness({ dir: first.dir, products });
    await h.conversation.handle(voice);
    expect(listTexts(h.sent)).toBe(0);
    expect(h.sent.filter((x) => x.kind === "button")).toHaveLength(1);
    expect(h.calls).toMatchObject({ cutouts: 0, transcribe: 0, price: 0 });
  });

  for (const yes of ["👍🏾", "👍🏽", "👍👍", "👍", "yes please", "Yes please", "Yes o", "ok o", "Okay o", "confirm", "Confirmed", "yes,", "yes sir", "Yes publish it", "Yes, publish!", "Yes 👍", "sure", "oya", "done", "Yes!", "Na so!"]) {
    test(`B3: ${JSON.stringify(yes)} publishes with no extra pricing call`, async () => {
      await toList();
      const priced = h.calls.price;
      await h.conversation.handle(msg.text(yes));
      expect(h.calls.publish).toBe(1);
      expect(h.calls.price).toBe(priced);
    });
  }
  for (const no of ["yes but rice na 7000", "no", "OK?", "not yet", "yes rice na 7000"]) {
    test(`B3: ${JSON.stringify(no)} does not publish`, () => expect(isYes(no)).toBe(false));
  }

  test("B3: a reaction while confirming gets the tap reminder, not the 'photos, voice notes and text' reply", async () => {
    await toList();
    await h.conversation.handle(msg.other("reaction"));
    expect(h.last().body).toBe(copy.tapToPublish);
    expect(h.calls.publish).toBe(0);
  });

  test("B4: the old list's button after a new photo gets no welcome text, and nothing is published", async () => {
    const id = await toList();
    await h.conversation.handle(msg.photo("photo-2"));
    await h.conversation.handle(msg.button(id));
    expect(h.last().body).toBe(copy.oldListAfterPhoto);
    expect(h.texts()).not.toContain(copy.welcome);
    expect(h.calls.publish).toBe(0);
  });

  test("Optional 2: a message older than 23 hours starts no paid work and gets no reply", async () => {
    h = harness({ now: () => 2 * MAX_MESSAGE_AGE_MS });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    expect(h.calls).toMatchObject({ cutouts: 0, transcribe: 0, price: 0 });
    expect(h.texts()).toEqual([]);
  });

  test("a bad photo or a silent voice note keeps the job open (the step's answer is saved, not failed)", async () => {
    h = harness({ media: { "photo-bad": new TextEncoder().encode("not a jpeg") } });
    await h.conversation.handle(msg.voice("silence"));
    await h.conversation.handle(msg.photo("photo-bad"));
    const s = h.store.get(TRADER)!;
    expect(h.log.job(s.jobId)?.status).toBe("open");
  });
});

// Grok review on PR #8.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../../src/meta/client.ts";
import { priceItems } from "../../src/pipeline/pricing.ts";
import { scriptedSpark, setPrice } from "../../src/pipeline/test-spark.ts";
import { SpendGuard } from "../../src/spend-guard.ts";
import { WORST_CALLS } from "../../src/whatsapp/conversation.ts";
import { changeExample } from "../../src/whatsapp/copy.ts";

describe("Grok review on PR #8", () => {
  for (const names of [["Rice", "Garri"], ["Peak milk tin", "Tomato paste"], ["Ankara fabric"]]) {
    test(`the list's own change example is accepted by the real price check (${names.join(", ")})`, async () => {
      const lines = names.map((name, i) => ({ item: i + 1, name, price: null, question: null }));
      const example = changeExample(lines);
      expect(copy.list(lines)).toContain(`like "${example}"`);
      const dir = mkdtempSync(join(tmpdir(), "grok8-"));
      const guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
      const spark = scriptedSpark([[setPrice(1, 1500, "piece", example)], "done"]);
      const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "g8", names.map((name, i) => ({ item: i + 1, name })), [example]);
      expect(r.lines[0]!.price?.naira).toBe(1500);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  for (const chat of ["thanks", "Thank you so much", "ok then", "how much do you charge?", "👍🏾 nice"]) {
    test(`${JSON.stringify(chat)} after the list gets a hint and starts no paid pricing`, async () => {
      await toList();
      const priced = h.calls.price;
      const changes = h.store.get(TRADER)!.changes;
      await h.conversation.handle(msg.text(chat));
      expect(h.calls.price).toBe(priced);
      expect(h.store.get(TRADER)!.changes).toBe(changes);
      expect(h.last().body).toBe(copy.changeHint(h.store.get(TRADER)!.lines));
      expect(h.calls.publish).toBe(0);
    });
  }

  test("a voice note after the list with no number in it is transcribed but not priced again", async () => {
    await toList();
    const priced = h.calls.price;
    await h.conversation.handle(msg.voice("thank you my sister"));
    expect(h.calls.price).toBe(priced);
    expect(h.last().body).toBe(copy.changeHint(h.store.get(TRADER)!.lines));
    expect(h.store.get(TRADER)!.phase).toBe("confirming");
  });

  test("a change is refused before any paid step when the job can't afford it", async () => {
    let left = 100;
    h = harness({ callsLeft: () => left });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    const priced = h.calls.price;
    const transcribed = h.calls.transcribe;
    left = WORST_CALLS.pricing + WORST_CALLS.transcript - 1;
    await h.conversation.handle(msg.voice("rice na 7000"));
    expect(h.last().body).toBe(copy.tooManyChanges);
    expect(h.calls.price).toBe(priced);
    expect(h.calls.transcribe).toBe(transcribed);
    left = WORST_CALLS.pricing - 1;
    await h.conversation.handle(msg.text("rice na 7000"));
    expect(h.last().body).toBe(copy.tooManyChanges);
    expect(h.calls.price).toBe(priced);
    expect(h.store.get(TRADER)!.phase).toBe("confirming");
  });

  test("a first run whose cut-outs used up the budget stops with an accurate message before pricing", async () => {
    let left = 100;
    h = harness({ callsLeft: () => left, models: { cutouts: async () => ((left = 5), [{ name: "Rice", png: new Uint8Array([1]) }]) } });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(msg.voice("rice na 6000"));
    expect(h.calls.price).toBe(0);
    expect(h.last().body).toBe(copy.jobTooBig);
    expect(h.store.get(TRADER)!.phase).toBe("failed");
  });

  test("by design, a whole job stays under the 60-call cap: the worst pricing round plus a voice note fits after the 35-call cut-out bound", () => {
    expect(35 + WORST_CALLS.transcript + WORST_CALLS.pricing).toBeLessThan(60);
  });
});
