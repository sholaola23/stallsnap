import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GraphClient, GraphError, MediaError, PAIR_GAP_MS } from "./graph.ts";

type Req = { url: string; method: string; auth: string | null; body: any };

function fakeGraph(handler: (r: Req) => Response | unknown) {
  const reqs: Req[] = [];
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const r = { url: String(input), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    reqs.push(r);
    const out = handler(r);
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  }) as typeof globalThis.fetch;
  const client = new GraphClient({
    token: "SECRET-TOKEN",
    phoneNumberId: "PNID",
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { client, reqs, sleeps, tick: (ms: number) => (clock += ms) };
}

const sent = { messaging_product: "whatsapp", messages: [{ id: "wamid.OUT" }] };

describe("sending", () => {
  test("text", async () => {
    const g = fakeGraph(() => sent);
    expect(await g.client.sendText("447700900123", "Hello")).toBe("wamid.OUT");
    expect(g.reqs[0]).toMatchObject({ url: "https://graph.facebook.com/v26.0/PNID/messages", method: "POST", auth: "Bearer SECRET-TOKEN" });
    expect(g.reqs[0]!.body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "447700900123", type: "text", text: { preview_url: false, body: "Hello" } });
  });

  test("one reply button", async () => {
    const g = fakeGraph(() => sent);
    await g.client.sendButton("447700900123", "Your list", { id: "confirm:v2", title: "Yes, publish" });
    expect(g.reqs[0]!.body.interactive).toEqual({
      type: "button",
      body: { text: "Your list" },
      action: { buttons: [{ type: "reply", reply: { id: "confirm:v2", title: "Yes, publish" } }] },
    });
  });

  test("a button body over 1024 characters is refused before sending", () => {
    const g = fakeGraph(() => sent);
    expect(() => g.client.sendButton("4477", "x".repeat(1025), { id: "a", title: "b" })).toThrow("1024");
    expect(g.reqs).toHaveLength(0);
  });

  test("link button", async () => {
    const g = fakeGraph(() => sent);
    await g.client.sendLink("447700900123", "Your catalogue is ready", "Open catalogue", "https://example.test/c/abc");
    expect(g.reqs[0]!.body.interactive).toEqual({
      type: "cta_url",
      body: { text: "Your catalogue is ready" },
      action: { name: "cta_url", parameters: { display_text: "Open catalogue", url: "https://example.test/c/abc" } },
    });
  });

  test("typing indicator marks the message read; a failure is ignored", async () => {
    const g = fakeGraph(() => new Response("{}", { status: 400 }));
    await g.client.typing("wamid.IN");
    expect(g.reqs[0]!.body).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.IN", typing_indicator: { type: "text" } });
  });
});

describe("pacing and retries", () => {
  test("messages to one person are 6 seconds apart and in order; another person isn't held up", async () => {
    const g = fakeGraph(() => sent);
    await Promise.all([g.client.sendText("A", "1"), g.client.sendText("A", "2"), g.client.sendText("B", "x")]);
    expect(g.reqs.map((r) => `${r.body.to}:${r.body.text.body}`)).toEqual(["A:1", "B:x", "A:2"]);
    expect(g.sleeps).toEqual([PAIR_GAP_MS]);
  });

  test("a rate limit is retried after 1 s", async () => {
    let n = 0;
    const g = fakeGraph(() => (n++ === 0 ? new Response(JSON.stringify({ error: { code: 131056, message: "pair rate limit" } }), { status: 400 }) : sent));
    expect(await g.client.sendText("A", "hi")).toBe("wamid.OUT");
    expect(g.sleeps).toEqual([1000]);
  });

  test("server errors are retried 3 times, then thrown", async () => {
    const g = fakeGraph(() => new Response("oops", { status: 503 }));
    await expect(g.client.sendText("A", "hi")).rejects.toBeInstanceOf(GraphError);
    expect(g.reqs).toHaveLength(4);
    expect(g.sleeps).toEqual([1000, 4000, 16000]);
  });

  test("other errors are not retried, and the token never appears in the error", async () => {
    const g = fakeGraph(() => new Response(JSON.stringify({ error: { code: 131030, message: "Recipient not in allowed list" } }), { status: 400 }));
    const err = (await g.client.sendText("A", "hi").catch((e: unknown) => e)) as GraphError;
    expect(err).toBeInstanceOf(GraphError);
    expect(err.message).toContain("131030");
    expect(err.message).not.toContain("SECRET-TOKEN");
    expect(g.reqs).toHaveLength(1);
  });
});

describe("media download", () => {
  const audio = new TextEncoder().encode("OggS fake opus bytes");
  const hex = createHash("sha256").update(audio).digest("hex");
  const accept = { mimeTypes: ["audio/ogg"], maxBytes: 1000 };
  const info = (over: Record<string, unknown> = {}) => ({ url: "https://lookaside.fbsbx.com/x", mime_type: "audio/ogg; codecs=opus", sha256: hex, file_size: audio.length, id: "m1", ...over });

  test("asks Meta for the URL, then downloads with the token and checks the hash", async () => {
    const g = fakeGraph((r) => (r.url.startsWith("https://graph.facebook.com") ? info() : new Response(audio)));
    const out = await g.client.download("m1", accept);
    expect(out.mimeType).toBe("audio/ogg");
    expect(new TextDecoder().decode(out.bytes)).toBe("OggS fake opus bytes");
    expect(g.reqs[0]!.url).toBe("https://graph.facebook.com/v26.0/m1?phone_number_id=PNID");
    expect(g.reqs[1]!.auth).toBe("Bearer SECRET-TOKEN");
  });

  test("an expired URL (404) is fetched again once", async () => {
    let downloads = 0;
    const g = fakeGraph((r) => (r.url.startsWith("https://graph.facebook.com") ? info() : downloads++ === 0 ? new Response("", { status: 404 }) : new Response(audio)));
    await g.client.download("m1", accept);
    expect(g.reqs.filter((r) => r.url.startsWith("https://graph.facebook.com"))).toHaveLength(2);
  });

  test("wrong type, too big by declaration, too big in fact, bad hash, and non-https URL are refused", async () => {
    const cases: [Record<string, unknown>, Uint8Array, string][] = [
      [{ mime_type: "video/mp4" }, audio, "wrong-type"],
      [{ mime_type: "audio/ogg; codecs=vorbis" }, audio, "wrong-type"],
      [{ file_size: 5000 }, audio, "too-big"],
      [{ file_size: undefined }, new Uint8Array(2000), "too-big"],
      [{ sha256: "deadbeef" }, audio, "corrupt"],
      [{ url: "http://insecure.test/x" }, audio, "unavailable"],
    ];
    for (const [over, body, reason] of cases) {
      const g = fakeGraph((r) => (r.url.startsWith("https://graph.facebook.com") ? info(over) : new Response(body)));
      const accepted = over.mime_type === "audio/ogg; codecs=vorbis" ? { ...accept, mimeTypes: ["audio/ogg;codecs=opus"] } : accept;
      await expect(g.client.download("m1", accepted)).rejects.toMatchObject({ reason });
    }
  });

  test("a base64 hash is accepted too", async () => {
    const b64 = createHash("sha256").update(audio).digest("base64");
    const g = fakeGraph((r) => (r.url.startsWith("https://graph.facebook.com") ? info({ sha256: b64 }) : new Response(audio)));
    await expect(g.client.download("m1", accept)).resolves.toBeDefined();
  });

  test("MediaError is what callers catch", () => expect(new MediaError("too-big", "x")).toBeInstanceOf(Error));
});
