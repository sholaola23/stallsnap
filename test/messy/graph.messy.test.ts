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
