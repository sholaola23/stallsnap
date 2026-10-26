// Messy-input suite: WhatsApp settings, signatures and webhook bodies.
import { describe, expect, test } from "bun:test";
import { loadWebhookConfig, parseAllowedNumbers } from "../../src/whatsapp/config.ts";
import { parseWebhook } from "../../src/whatsapp/parse.ts";
import { signatureIsValid } from "../../src/whatsapp/signature.ts";
import { message, payload, sign } from "../../src/whatsapp/test-helpers.ts";

describe("ALLOWED_NUMBERS", () => {
  test("accepts the ways people write international numbers", () => {
    expect([...parseAllowedNumbers("+44 7700 900123, 0044-7700-900124;(234) 803 123 4567\n2348031234568, ,")]).toEqual([
      "447700900123",
      "447700900124",
      "2348031234567",
      "2348031234568",
    ]);
  });

  test("a duplicate is kept once", () => {
    expect(parseAllowedNumbers("447700900123,+447700900123").size).toBe(1);
  });

  for (const bad of [
    "07700900123", // local UK format: would never match
    "08031234567", // local Nigerian format
    "44770O900123", // letter O for zero
    "4477OO9OO123",
    "N/A",
    "447700",
    "4477009001234567890",
    "+",
    "me",
  ]) {
    test(`${JSON.stringify(bad)} stops start-up`, () => expect(() => parseAllowedNumbers(bad)).toThrow());
  }

  test("only separators means no numbers, which stops start-up", () => {
    expect(() =>
      loadWebhookConfig({ APP_SECRET: "s", WHATSAPP_VERIFY_TOKEN: "t", ALLOWED_NUMBERS: " , ; " }),
    ).toThrow("no numbers");
  });
});

describe("missing settings stop start-up and are all named", () => {
  test("nothing set", () => {
    expect(() => loadWebhookConfig({})).toThrow("APP_SECRET, WHATSAPP_VERIFY_TOKEN, ALLOWED_NUMBERS");
  });
  test("placeholder secret", () => {
    expect(() =>
      loadWebhookConfig({ APP_SECRET: "changeme", WHATSAPP_VERIFY_TOKEN: "t", ALLOWED_NUMBERS: "447700900123" }),
    ).toThrow("APP_SECRET");
  });
  test("phone number id may stay unset", () => {
    expect(
      loadWebhookConfig({ APP_SECRET: "s", WHATSAPP_VERIFY_TOKEN: "t", ALLOWED_NUMBERS: "447700900123" }).phoneNumberId,
    ).toBeUndefined();
  });
});

describe("X-Hub-Signature-256 header", () => {
  const raw = new TextEncoder().encode('{"object":"whatsapp_business_account"}');
  const good = sign(raw);
  test("upper-case hex and surrounding spaces still match", () => {
    expect(signatureIsValid(raw, good.toUpperCase().replace("SHA256=", "sha256="), "test-app-secret")).toBe(true);
    expect(signatureIsValid(raw, ` ${good} `, "test-app-secret")).toBe(true);
  });
  for (const bad of ["", "sha256", good.slice(0, -1), `${good}0`, good.replace("sha256=", "SHA256="), `${good},${good}`, good.replace(/.$/, "g")]) {
    test(`rejects ${JSON.stringify(bad.slice(0, 20))}...`, () => expect(signatureIsValid(raw, bad, "test-app-secret")).toBe(false));
  }
  test("an empty body still needs a valid signature", () => {
    expect(signatureIsValid(new Uint8Array(), sign(""), "test-app-secret")).toBe(true);
    expect(signatureIsValid(new Uint8Array(), good, "test-app-secret")).toBe(false);
  });
});

describe("webhook bodies that aren't what we expect", () => {
  for (const [name, body] of [
    ["null", null],
    ["array", []],
    ["string", "hello"],
    ["other object", { object: "page", entry: [] }],
    ["entry not array", { object: "whatsapp_business_account", entry: {} }],
    ["changes null", { object: "whatsapp_business_account", entry: [{ changes: null }] }],
    ["value missing", { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages" }] }] }],
  ] as const) {
    test(`${name} gives no messages`, () => expect(parseWebhook(body)).toEqual([]));
  }

  test("broken messages are skipped, good ones in the same batch are kept", () => {
    const got = parseWebhook(
      payload([
        null,
        "text",
        message("text", { text: { body: "" } }), // empty text
        message("text", {}), // no text object
        message("image", { image: {} }), // no media id
        { ...message("text", { text: { body: "x" } }), from: "+44 7700" }, // bad number
        { ...message("text", { text: { body: "x" } }), id: "" }, // no id
        { ...message("text", { text: { body: "x" } }), timestamp: "soon" }, // bad time
        message("text", { text: { body: "Rice na 6k" } }),
      ]),
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "text", text: "Rice na 6k" });
  });

  test("messages are sorted by timestamp, not by position in the batch", () => {
    const late = { ...message("text", { text: { body: "second" } }), timestamp: "1793000500" };
    const early = { ...message("text", { text: { body: "first" } }), timestamp: "1793000100" };
    expect(parseWebhook(payload([late, early])).map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["first", "second"]);
  });

  test("a button reply with no id is skipped", () => {
    expect(parseWebhook(payload([message("interactive", { interactive: { type: "button_reply", button_reply: { title: "Yes" } } })]))).toEqual([]);
  });
});

// QA round 1 on PR #3.
describe("QA round 1 on PR #3", () => {
  test("a (0) trunk prefix is dropped, so the trader isn't locked out", () => {
    expect([...parseAllowedNumbers("+44 (0)7700 900123")]).toEqual(["447700900123"]);
    expect([...parseAllowedNumbers("+234 (0)803 123 4567")]).toEqual(["2348031234567"]);
    expect([...parseAllowedNumbers("0044 (0) 7700-900123")]).toEqual(["447700900123"]);
  });

  test("invisible direction marks copied from phone contacts are removed", () => {
    expect([...parseAllowedNumbers("‪+44 7700 900123‬, ‎+234 803 123 4567")]).toEqual(["447700900123", "2348031234567"]);
  });

  for (const bad of ["07700900123", "07700 900123", "44770O900123", "N/A", "+44 (020) 7946 0000", "+44 020 7946 0000", "+234 0803 123 4567"]) {
    test(`the error for ${JSON.stringify(bad)} shows at most its last 4 digits`, () => {
      let message = "";
      try {
        parseAllowedNumbers(`447700900999, ${bad}`);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("entry 2");
      const digits = bad.replace(/\D/g, "");
      if (digits.length > 4) expect(message).not.toContain(digits);
      // No run of 5 or more digits from the number; the sample number in the hint is allowed.
      expect(message.replace("447700900123", "")).not.toMatch(/\d{5,}/);
    });
  }
});
