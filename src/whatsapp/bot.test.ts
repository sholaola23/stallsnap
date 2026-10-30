import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogueStore } from "../catalogue/store.ts";
import { handler } from "../server.ts";
import { parseAllowedNumbers } from "../main.ts";
import { samLine, samStream, syntheticStall, testBudget, testClient, textStream, toolStream } from "../test/fakes.ts";
import { Bot, COPY } from "./bot.ts";
import type { WhatsAppSender } from "./graph.ts";
import { incomingMessages, validSignature } from "./webhook.ts";

const TRADER = "447700900123";
const STRANGER = "2348000000000";
const SECRET = "test-app-secret";

const find = textStream(
  JSON.stringify({
    products: [
      { name: "Tomato", x_min: 120, y_min: 330, x_max: 380, y_max: 670 },
      { name: "Blue soap bar", x_min: 620, y_min: 330, x_max: 880, y_max: 670 },
    ],
  }),
);
const masks = samStream(
  samLine([
    { id: 1, left: 100, top: 200, right: 300, bottom: 400, fill: (x, y) => (x - 100) ** 2 + (y - 100) ** 2 <= 100 ** 2 },
    { id: 2, left: 500, top: 200, right: 700, bottom: 400, fill: () => true },
  ]),
);
const note = "Tomato na 500 each";
const priceTomato = toolStream([
  ["set_price", { product_id: 1, amount_naira: 500, unit: "each", quote: "Tomato na 500" }],
  ["ask_trader", { product_id: 2, question: "How much is the blue soap?" }],
]);

class FakeSender implements WhatsAppSender {
  sent: { to: string; body: string }[] = [];
  constructor(private readonly media: Record<string, Buffer>) {}
  async sendText(to: string, body: string) {
    this.sent.push({ to, body });
  }
  async download(id: string) {
    const bytes = this.media[id];
    if (!bytes) throw new Error(`no media ${id}`);
    return bytes;
  }
}

async function setup(answers: Record<string, string | number | (string | number)[]>, budget = testBudget()) {
  const dataDir = mkdtempSync(join(tmpdir(), "stallsnap-bot-"));
  const { client, calls } = testClient(answers, budget);
  const sender = new FakeSender({ photo1: await syntheticStall(), junk: Buffer.from("not a photo") });
  const store = new CatalogueStore(join(dataDir, "catalogues"));
  const make = () =>
    new Bot({ client, sender, store, dataDir, publicUrl: "https://stallsnap.example/", stallName: "Test stall", allowedNumbers: new Set([TRADER]) });
  return { bot: make(), make, sender, calls, store, dataDir };
}

let n = 0;
const msg = (m: Record<string, unknown>) => ({ id: `wamid.${++n}`, from: TRADER, ...m }) as any;
const last = (sender: FakeSender) => sender.sent.at(-1)!.body;

describe("the WhatsApp conversation", () => {
  test("photo, typed prices, YES: the trader gets a link to a page with their goods", async () => {
    const { bot, sender, calls, store } = await setup({ "muse-spark-1.3": [find, priceTomato, textStream("DONE")], "sam-3.1": masks });

    await bot.receive(msg({ kind: "image", mediaId: "photo1" }));
    expect(sender.sent.map((s) => s.body)).toEqual([COPY.working, "I found 2 items:\n1. Tomato\n2. Blue soap bar\n\nNow send a voice note saying the price of each one."]);

    await bot.receive(msg({ kind: "text", text: note }));
    expect(last(sender)).toContain("1. Tomato: ₦500 each");
    expect(last(sender)).toContain("- How much is the blue soap?");

    await bot.receive(msg({ kind: "text", text: "Yes!" }));
    const link = last(sender).match(/https:\/\/stallsnap\.example\/c\/([a-z0-9]{12})/);
    expect(link).not.toBeNull();
    const catalogue = store.get(link![1]!)!;
    expect(catalogue.items.map((i) => [i.name, i.amount])).toEqual([
      ["Tomato", 500],
      ["Blue soap bar", null],
    ]);
    expect(sender.sent.every((s) => s.to === TRADER)).toBe(true);
    expect(calls.map((c) => c.model)).toEqual(["muse-spark-1.3", "sam-3.1", "muse-spark-1.3", "muse-spark-1.3"]);
  });

  test("a voice note is transcribed with the photo's product names and priced", async () => {
    const tone = Bun.spawn(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "libopus", "-f", "ogg", "pipe:1"], { stdout: "pipe" });
    const { bot, sender, calls } = await setup({
      "muse-spark-1.3": [find, priceTomato, textStream("DONE")],
      "sam-3.1": masks,
      "muse-voice-transcribe-1.0": JSON.stringify({ transcript: note, audioDurationMs: 1000 }),
    });
    (sender as any).media.voice1 = Buffer.from(await new Response(tone.stdout).arrayBuffer());
    await bot.receive(msg({ kind: "image", mediaId: "photo1" }));
    await bot.receive(msg({ kind: "audio", mediaId: "voice1" }));
    expect(last(sender)).toContain("1. Tomato: ₦500 each");
    expect(calls.find((c) => c.model === "muse-voice-transcribe-1.0")!.body.keywords).toEqual(["Tomato", "Blue soap bar"]);
  });

  test("a change after publishing republishes to the same link", async () => {
    const { bot, sender } = await setup({
      "muse-spark-1.3": [find, priceTomato, textStream("DONE"), toolStream([["set_price", { product_id: 1, amount_naira: 600, unit: "each", quote: "600" }]]), textStream("DONE")],
      "sam-3.1": masks,
    });
    await bot.receive(msg({ kind: "image", mediaId: "photo1" }));
    await bot.receive(msg({ kind: "text", text: note }));
    await bot.receive(msg({ kind: "text", text: "YES" }));
    const first = last(sender).match(/\/c\/(\w+)/)![1];
    await bot.receive(msg({ kind: "text", text: "Tomato don go up, 600 now" }));
    expect(last(sender)).toContain("1. Tomato: ₦600 each");
    await bot.receive(msg({ kind: "text", text: "ok" }));
    expect(last(sender).match(/\/c\/(\w+)/)![1]).toBe(first);
  });

  test("messages from numbers not on the list are dropped before any paid call", async () => {
    const { bot, sender, calls } = await setup({ "muse-spark-1.3": find, "sam-3.1": masks });
    await bot.receive({ id: "wamid.x1", from: STRANGER, kind: "image", mediaId: "photo1" });
    expect(sender.sent).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a webhook retry of the same message is handled once, even after a restart", async () => {
    const { bot, make, sender, calls } = await setup({ "muse-spark-1.3": find, "sam-3.1": masks });
    const photo = msg({ kind: "image", mediaId: "photo1" });
    await bot.receive(photo);
    await bot.receive(photo);
    await make().receive(photo);
    expect(calls).toHaveLength(2);
    expect(sender.sent).toHaveLength(2);
  });

  test("the session survives a restart", async () => {
    const { bot, make, sender } = await setup({ "muse-spark-1.3": [find, priceTomato, textStream("DONE")], "sam-3.1": masks });
    await bot.receive(msg({ kind: "image", mediaId: "photo1" }));
    await make().receive(msg({ kind: "text", text: note }));
    expect(last(sender)).toContain("Tomato: ₦500 each");
  });

  test("out-of-order and unsupported messages get a helpful answer and no paid call", async () => {
    const { bot, sender, calls } = await setup({});
    await bot.receive(msg({ kind: "text", text: "YES" }));
    await bot.receive(msg({ kind: "text", text: "hello" }));
    await bot.receive(msg({ kind: "audio", mediaId: "voice1" }));
    await bot.receive(msg({ kind: "other" }));
    expect(sender.sent.map((s) => s.body)).toEqual([COPY.nothingToPublish, COPY.welcome, COPY.photoFirst, COPY.unsupported]);
    expect(calls).toEqual([]);
  });

  test("YES after the photo but before any prices asks for prices", async () => {
    const { bot, sender } = await setup({ "muse-spark-1.3": find, "sam-3.1": masks });
    await bot.receive(msg({ kind: "image", mediaId: "photo1" }));
    await bot.receive(msg({ kind: "text", text: "yes" }));
    expect(last(sender)).toBe(COPY.pricesFirst);
  });

  test("a file that isn't a photo gets the photo message, not a crash", async () => {
    const { bot, sender, calls } = await setup({});
    await bot.receive(msg({ kind: "image", mediaId: "junk" }));
    expect(last(sender)).toContain("isn't a photo I can open");
    expect(calls).toEqual([]);
  });

  test("a photo with nothing found asks for a clearer one", async () => {
    const { bot, sender } = await setup({ "muse-spark-1.3": textStream('{"products":[]}') });
    await bot.receive(msg({ kind: "image", mediaId: "photo1" }));
    expect(last(sender)).toBe(COPY.noProducts);
  });

  test("when the spend cap is hit the trader hears StallSnap is paused", async () => {
    const { bot, sender } = await setup({ "muse-spark-1.3": find }, testBudget({ live: false }));
    await bot.receive(msg({ kind: "image", mediaId: "photo1" }));
    expect(last(sender)).toBe(COPY.paused);
  });

  test("an API failure gets a plain apology", async () => {
    const { bot, sender } = await setup({ "muse-spark-1.3": 500 });
    await bot.receive(msg({ kind: "image", mediaId: "photo1" }));
    expect(last(sender)).toBe(COPY.failed);
  });

  test("one trader's messages are handled in order even when they arrive together", async () => {
    const { bot, sender } = await setup({ "muse-spark-1.3": [find, priceTomato, textStream("DONE")], "sam-3.1": masks });
    await Promise.all([
      bot.receive(msg({ kind: "image", mediaId: "photo1" })),
      bot.receive(msg({ kind: "text", text: note })),
      bot.receive(msg({ kind: "text", text: "YES" })),
    ]);
    expect(sender.sent).toHaveLength(4);
    expect(last(sender)).toStartWith("Your price list is live:");
  });
});

describe("the webhook", () => {
  const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  const payload = (messages: unknown[]) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages } }] }] });

  async function server() {
    const { bot, sender } = await setup({});
    return { serve: handler(new CatalogueStore(mkdtempSync(join(tmpdir(), "c-"))), { bot, appSecret: SECRET, verifyToken: "verify-me" }), sender };
  }

  test("answers Meta's verification check only with the right token", async () => {
    const { serve } = await server();
    const ok = await serve(new Request("http://x/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345"));
    expect(await ok.text()).toBe("12345");
    expect((await serve(new Request("http://x/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"))).status).toBe(403);
  });

  test("refuses unsigned, wrongly signed and oversized calls", async () => {
    const { serve, sender } = await server();
    const body = payload([{ id: "wamid.s1", from: TRADER, type: "text", text: { body: "hello" } }]);
    for (const signature of [null, "sha256=00", sign(body + " "), "md5=abc"]) {
      const headers: Record<string, string> = signature ? { "X-Hub-Signature-256": signature } : {};
      expect((await serve(new Request("http://x/webhook", { method: "POST", body, headers }))).status).toBe(403);
    }
    const huge = "x".repeat(1024 * 1024 + 1);
    expect((await serve(new Request("http://x/webhook", { method: "POST", body: huge, headers: { "X-Hub-Signature-256": sign(huge) } }))).status).toBe(413);
    expect(sender.sent).toEqual([]);
  });

  test("a signed message reaches the bot", async () => {
    const { serve, sender } = await server();
    const body = payload([{ id: "wamid.s2", from: TRADER, type: "text", text: { body: "hello" } }]);
    const response = await serve(new Request("http://x/webhook", { method: "POST", body, headers: { "X-Hub-Signature-256": sign(body) } }));
    expect(response.status).toBe(200);
    await Bun.sleep(10);
    expect(sender.sent.map((s) => s.body)).toEqual([COPY.welcome]);
  });

  test("reads every message shape and ignores status updates and junk", () => {
    const body = {
      entry: [
        {
          changes: [
            { value: { statuses: [{ id: "wamid.st", status: "read" }] } },
            {
              value: {
                messages: [
                  { id: "a", from: TRADER, type: "image", image: { id: "m1" } },
                  { id: "b", from: TRADER, type: "audio", audio: { id: "m2", voice: true } },
                  { id: "c", from: TRADER, type: "button", button: { text: "YES" } },
                  { id: "d", from: TRADER, type: "interactive", interactive: { button_reply: { title: "YES" } } },
                  { id: "e", from: TRADER, type: "sticker", sticker: { id: "m3" } },
                  { id: "f", from: TRADER, type: "image", image: {} },
                  { from: TRADER, type: "text", text: { body: "no id" } },
                  null,
                ],
              },
            },
          ],
        },
        "junk",
      ],
    };
    expect(incomingMessages(body).map((m) => m.kind)).toEqual(["image", "audio", "text", "text", "other", "other"]);
    expect(incomingMessages(null)).toEqual([]);
    expect(incomingMessages({ entry: "x" })).toEqual([]);
  });

  test("signature check", () => {
    expect(validSignature("{}", sign("{}"), SECRET)).toBe(true);
    expect(validSignature("{}", sign("{}"), "other")).toBe(false);
    expect(validSignature("{}", "sha256=zz", SECRET)).toBe(false);
  });
});

describe("settings", () => {
  test("allowed numbers accept common formats and refuse junk", () => {
    expect([...parseAllowedNumbers("+44 7700 900123, (234) 800-000-0000,")]).toEqual(["447700900123", "2348000000000"]);
    expect(() => parseAllowedNumbers("me")).toThrow();
    expect(() => parseAllowedNumbers("123")).toThrow();
  });
});
