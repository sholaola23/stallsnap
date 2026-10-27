// Messy-input suite: outbound WhatsApp messages with text that doesn't fit.
import { expect, test } from "bun:test";
import { GraphClient } from "../../src/whatsapp/graph.ts";

function capture() {
  const bodies: any[] = [];
  const client = new GraphClient({
    token: "t",
    phoneNumberId: "p",
    sleep: async () => {},
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: "w" }] }));
    }) as typeof fetch,
  });
  return { client, bodies };
}

test("text over 4096 characters is clipped, never refused by Meta", async () => {
  const { client, bodies } = capture();
  await client.sendText("4477", "₦".repeat(5000));
  expect(bodies[0].text.body.length).toBe(4096);
  expect(bodies[0].text.body.endsWith("…")).toBe(true);
});

test("a button title over 20 characters is clipped", async () => {
  const { client, bodies } = capture();
  await client.sendButton("4477", "List", { id: "x", title: "Yes, publish my catalogue now" });
  expect(bodies[0].interactive.action.buttons[0].reply.title.length).toBe(20);
});

test("a link body over 1024 characters is clipped", async () => {
  const { client, bodies } = capture();
  await client.sendLink("4477", "x".repeat(2000), "Open catalogue", "https://example.test/c/a");
  expect(bodies[0].interactive.body.text.length).toBe(1024);
});

test("empty text is still sent as text, not dropped silently", async () => {
  const { client, bodies } = capture();
  await client.sendText("4477", "");
  expect(bodies).toHaveLength(1);
});

// Grok review on PR #7: Graph calls time out, and the token only goes to Meta's media hosts.
import { GraphError, MediaError, isMetaMediaUrl } from "../../src/whatsapp/graph.ts";

const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));

test("a Graph API call that never answers fails with GraphError after its retries, not forever", async () => {
  let calls = 0;
  const client = new GraphClient({ token: "t", phoneNumberId: "p", timeoutMs: 20, sleep: async () => {}, fetch: (async (_u: unknown, init?: RequestInit) => (calls++, hang(init))) as typeof fetch });
  const started = Date.now();
  await expect(client.sendText("4477", "hi")).rejects.toBeInstanceOf(GraphError);
  expect(calls).toBe(4); // first try plus 3 retries
  expect(Date.now() - started).toBeLessThan(2000);
});

function mediaClient(url: string, onMedia: (init?: RequestInit) => Promise<Response>) {
  const asked: { url: string; auth: string | null }[] = [];
  const client = new GraphClient({
    token: "SECRET",
    phoneNumberId: "p",
    timeoutMs: 20,
    sleep: async () => {},
    fetch: (async (u: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(u), auth: new Headers(init?.headers).get("authorization") });
      if (String(u).startsWith("https://graph.facebook.com/")) return new Response(JSON.stringify({ url, mime_type: "image/jpeg", file_size: 10 }));
      return onMedia(init);
    }) as typeof fetch,
  });
  return { client, asked };
}
const accept = { mimeTypes: ["image/jpeg"], maxBytes: 1000 };

test("a media download that never answers fails with MediaError within the timeout", async () => {
  const { client } = mediaClient("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", hang);
  const err = await client.download("m1", accept).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MediaError);
  expect((err as MediaError).reason).toBe("unavailable");
});

for (const url of [
  "https://evil.test/x",
  "https://lookaside.fbsbx.com.evil.test/x",
  "https://evilfbsbx.com/x",
  "https://user@lookaside.fbsbx.com/x",
  "https://lookaside.fbsbx.com:8443/x",
  "http://lookaside.fbsbx.com/x",
  "not a url",
]) {
  test(`a media URL on ${JSON.stringify(url)} is refused and the token is never sent there`, async () => {
    const { client, asked } = mediaClient(url, async () => new Response(new Uint8Array(5)));
    const err = await client.download("m1", accept).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect(asked.filter((a) => !a.url.startsWith("https://graph.facebook.com/"))).toEqual([]);
  });
}

test("Meta's media hosts are accepted", () => {
  for (const ok of ["https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", "https://scontent.xx.fbcdn.net/v/t1", "https://mmg.whatsapp.net/d/f/x.enc"]) expect(isMetaMediaUrl(ok)).toBe(true);
});
