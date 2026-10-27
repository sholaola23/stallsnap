// Messy-input suite: DEMO_WHATSAPP_NUMBER, the number behind the catalogue's
// "Message on WhatsApp" button. It must be the WhatsApp test number, never a trader's.
import { describe, expect, test } from "bun:test";
import { loadDemoContact } from "../../src/whatsapp/config.ts";

const traders = new Set(["447700900123", "2348012345678"]);
const load = (v: string | undefined) => loadDemoContact(traders, { DEMO_WHATSAPP_NUMBER: v });

describe("DEMO_WHATSAPP_NUMBER", () => {
  test("blank or a placeholder means no button", () => {
    for (const v of [undefined, "", "   ", "changeme"]) expect(load(v)).toBeUndefined();
  });
  test("an international number in any common format becomes digits", () => {
    for (const v of ["+1 555 010 0199", "0015550100199", "1 (555) 010-0199"]) expect(load(v)).toBe("15550100199");
  });
  test("a trader's number stops start-up, in any format", () => {
    for (const v of ["+44 7700 900123", "447700900123", "+234 801 234 5678"]) expect(() => load(v)).toThrow("trader's number");
  });
  test("two numbers, a local number or not a number stop start-up", () => {
    expect(() => load("15550100199, 15550100198")).toThrow("one phone number");
    expect(() => load("07700900124")).toThrow();
    expect(() => load("not a number")).toThrow();
  });
  test("an error never shows the whole number", () => {
    try {
      load("+44 7700 900123");
    } catch (e) {
      expect(String(e)).not.toContain("7700900123");
    }
  });
});
