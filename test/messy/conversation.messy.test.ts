// Messy-input suite: conversations that don't go in the tidy order.
import { afterEach, describe, expect, test } from "bun:test";
import { copy } from "../../src/whatsapp/copy.ts";
import { MAX_INPUTS } from "../../src/whatsapp/conversation.ts";
import { TRADER, harness, msg } from "../../src/whatsapp/test-conversation.ts";

let h: ReturnType<typeof harness>;
afterEach(() => h?.cleanup());

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
    const other = (m: ReturnType<typeof msg.photo>) => ({ ...m, from: "2348031234567" });
    await h.conversation.handle(msg.photo());
    await h.conversation.handle(other(msg.photo()));
    await h.conversation.handle(other(msg.voice("rice na 100, garri na 200")));
    await h.conversation.handle(msg.voice("rice na 6000, garri na 1500"));
    const lists = h.sent.filter((s) => s.kind === "button");
    expect(lists.find((l) => l.to === TRADER)!.body).toContain("₦6,000");
    expect(lists.find((l) => l.to === "2348031234567")!.body).toContain("₦100");
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
