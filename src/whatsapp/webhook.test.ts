import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobLog } from "../joblog.ts";
import type { WebhookConfig } from "./config.ts";
import type { Inbound } from "./parse.ts";
import {
  STRANGER,
  VERIFY,
  handshake,
  message,
  payload,
  post,
  sign,
  testConfig,
} from "./test-helpers.ts";
import { MAX_BODY_BYTES, createWebhook } from "./webhook.ts";

let dir: string;
const logs: JobLog[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webhook-"));
});
afterEach(() => {
  for (const l of logs.splice(0)) l.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(config: WebhookConfig = testConfig(), handle?: (m: Inbound) => Promise<void>) {
  const log = new JobLog(join(dir, "joblog.jsonl"));
  logs.push(log);
  const got: Inbound[] = [];
  const errors: unknown[] = [];
  const webhook = createWebhook({
    config,
    log,
    handle: handle ?? (async (m) => void got.push(m)),
    onError: (_m, e) => errors.push(e),
  });
  return { webhook, log, got, errors };
}

describe("verify handshake", () => {
  test("echoes the challenge for the right token", async () => {
    const { webhook } = setup();
    const res = await webhook.fetch(handshake({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "1158201444" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  test("refuses a wrong token or mode", async () => {
    const { webhook } = setup();
    for (const params of <Record<string, string>[]>[
      { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" },
      { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY, "hub.challenge": "1" },
      { "hub.verify_token": VERIFY, "hub.challenge": "1" },
    ]) {
      expect((await webhook.fetch(handshake(params))).status).toBe(403);
    }
  });

  test("never echoes a challenge that isn't a number", async () => {
    const { webhook } = setup();
    const res = await webhook.fetch(
      handshake({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "<script>alert(1)</script>" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("script");
  });
});

describe("signature", () => {
  test("a signed batch is acknowledged and handled", async () => {
    const { webhook, got } = setup();
    const res = await webhook.fetch(post(payload([message("text", { text: { body: "hello" } })])));
    expect(res.status).toBe(200);
    await webhook.idle();
    expect(got.map((m) => m.kind)).toEqual(["text"]);
  });

  test("a missing, wrong or malformed signature gets 401 and nothing is handled", async () => {
    const { webhook, got, log } = setup();
    const body = payload([message("text", { text: { body: "hi" } })]);
    const raw = JSON.stringify(body);
    for (const signature of [null, sign(raw, "other-secret"), "sha256=", "sha1=abc", sign(raw).replace("sha256=", "")]) {
      expect((await webhook.fetch(post(body, { raw, signature }))).status).toBe(401);
    }
    await webhook.idle();
    expect(got).toEqual([]);
    expect(log.pending()).toEqual([]);
  });

  test("the check uses the raw body, not re-serialised JSON", async () => {
    const { webhook, got } = setup();
    // Meta escapes non-ASCII, so the raw bytes differ from JSON.stringify's output.
    const raw = `{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"100000000000001"},"messages":[{"from":"447700900123","id":"wamid.RAW1","timestamp":"1793000000","type":"text","text":{"body":"Rice na \\u20a66000"}}]}}]}]}`;
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect((await webhook.fetch(post(null, { raw, signature: sign(reserialised) }))).status).toBe(401);
    expect((await webhook.fetch(post(null, { raw, signature: sign(raw) }))).status).toBe(200);
    await webhook.idle();
    expect(got[0]).toMatchObject({ kind: "text", text: "Rice na ₦6000" });
  });

  test("an oversized body is refused before any work", async () => {
    const { webhook } = setup();
    const raw = "x".repeat(MAX_BODY_BYTES + 1);
    expect((await webhook.fetch(post(null, { raw }))).status).toBe(413);
  });
});

describe("allow-list", () => {
  test("a number not on the list is acknowledged but never handled or logged", async () => {
    const { webhook, got, log } = setup();
    const res = await webhook.fetch(post(payload([message("image", { image: { id: "m1", mime_type: "image/jpeg" } }, STRANGER)])));
    expect(res.status).toBe(200);
    await webhook.idle();
    expect(got).toEqual([]);
    expect(log.accept("probe", {})).toBe(true); // the stranger's id was never written
  });

  test("messages to another business number are dropped", async () => {
    const { webhook, got } = setup();
    await webhook.fetch(post(payload([message("text", { text: { body: "hi" } })], {}, "999")));
    await webhook.idle();
    expect(got).toEqual([]);
  });
});

describe("dedupe and restart", () => {
  test("a batch Meta delivers twice is handled once, also after a restart", async () => {
    const first = setup();
    const body = payload([message("text", { text: { body: "once" } }, undefined, "wamid.DUP")]);
    await first.webhook.fetch(post(body));
    await first.webhook.fetch(post(body));
    await first.webhook.idle();
    expect(first.got).toHaveLength(1);

    const second = setup();
    await second.webhook.fetch(post(body));
    second.webhook.recover();
    await second.webhook.idle();
    expect(second.got).toHaveLength(0);
  });

  test("a message a crash left unhandled is handled after restart", async () => {
    const first = setup(testConfig(), () => new Promise(() => {})); // dies mid-handling
    await first.webhook.fetch(post(payload([message("text", { text: { body: "lost?" } }, undefined, "wamid.CRASH")])));

    const second = setup();
    second.webhook.recover();
    await second.webhook.idle();
    expect(second.got.map((m) => m.id)).toEqual(["wamid.CRASH"]);
    expect(second.log.pending()).toEqual([]);
  });

  test("a handler that throws is reported and does not block the next message", async () => {
    let n = 0;
    const handled: string[] = [];
    const { webhook, errors, log } = setup(testConfig(), async (m) => {
      if (n++ === 0) throw new Error("pipeline failed");
      handled.push(m.id);
    });
    await webhook.fetch(post(payload([message("text", { text: { body: "a" } }, undefined, "wamid.A"), message("text", { text: { body: "b" } }, undefined, "wamid.B")])));
    await webhook.idle();
    expect(errors).toHaveLength(1);
    expect(handled).toEqual(["wamid.B"]);
    expect(log.pending()).toEqual([]);
  });
});

describe("message kinds", () => {
  test("voice notes arrive as type voice or as audio with voice: true", async () => {
    const { webhook, got } = setup();
    await webhook.fetch(
      post(
        payload([
          message("voice", { voice: { id: "v1", mime_type: "audio/ogg; codecs=opus" } }),
          message("audio", { audio: { id: "v2", mime_type: "audio/ogg; codecs=opus", voice: true } }),
          message("audio", { audio: { id: "a3", mime_type: "audio/mpeg" } }),
          message("image", { image: { id: "i4", mime_type: "image/jpeg", caption: "my stall" } }),
          message("interactive", { interactive: { type: "button_reply", button_reply: { id: "confirm:v1", title: "Yes, publish" } } }),
          message("sticker", { sticker: { id: "s5" } }),
        ]),
      ),
    );
    await webhook.idle();
    expect(got.map((m) => m.kind)).toEqual(["voice", "voice", "audio", "image", "button", "other"]);
    expect(got[3]).toMatchObject({ mediaId: "i4", caption: "my stall" });
    expect(got[4]).toMatchObject({ replyId: "confirm:v1" });
  });

  test("status receipts are ignored", async () => {
    const { webhook, got } = setup();
    await webhook.fetch(post(payload([], { statuses: [{ id: "wamid.X", status: "delivered" }] })));
    await webhook.idle();
    expect(got).toEqual([]);
  });
});

test("unknown paths and methods", async () => {
  const { webhook } = setup();
  expect((await webhook.fetch(new Request("http://localhost/nope"))).status).toBe(404);
  expect((await webhook.fetch(new Request("http://localhost/webhook", { method: "PUT" }))).status).toBe(405);
  expect((await webhook.fetch(new Request("http://localhost/health"))).status).toBe(200);
});

describe("someone who isn't a trader", () => {
  function withStranger() {
    const log = new JobLog(join(dir, "joblog.jsonl"));
    logs.push(log);
    const got: Inbound[] = [];
    const strangers: Inbound[] = [];
    const webhook = createWebhook({ config: testConfig(), log, handle: async (m) => void got.push(m), onStranger: (m) => void strangers.push(m) });
    return { webhook, got, strangers };
  }
  test("is passed to onStranger, never to the trader conversation", async () => {
    const { webhook, got, strangers } = withStranger();
    const res = await webhook.fetch(post(payload([message("text", { text: { body: "hi, is the rice fresh?" } }, STRANGER)])));
    expect(res.status).toBe(200);
    await webhook.idle();
    expect(got).toHaveLength(0);
    expect(strangers.map((m) => m.from)).toEqual([STRANGER]);
  });
  test("a trader's message never goes to onStranger", async () => {
    const { webhook, got, strangers } = withStranger();
    await webhook.fetch(post(payload([message("text", { text: { body: "rice na 1500" } })])));
    await webhook.idle();
    expect(got).toHaveLength(1);
    expect(strangers).toHaveLength(0);
  });
  test("a message to another business number goes nowhere", async () => {
    const { webhook, strangers } = withStranger();
    await webhook.fetch(post(payload([message("text", { text: { body: "hi" } }, STRANGER)], {}, "999")));
    expect(strangers).toHaveLength(0);
  });
  test("a bad signature reaches neither", async () => {
    const { webhook, got, strangers } = withStranger();
    const res = await webhook.fetch(post(payload([message("text", { text: { body: "hi" } }, STRANGER)]), { signature: "sha256=00" }));
    expect(res.status).toBe(401);
    expect(got.length + strangers.length).toBe(0);
  });
});
