// Messy-input suite: env values and the committed .env.example.
// Every QA attack on a promise gets a permanent case in test/messy/.
import { describe, expect, test } from "bun:test";
import { ENV_NAMES, readEnv } from "../../src/env.ts";

describe("placeholder secrets count as missing", () => {
  const placeholders = [
    "",
    "   ",
    "\t\n",
    "changeme",
    "CHANGEME",
    "TODO",
    "N/A",
    "n/a",
    "None",
    "null",
    "undefined",
    "xxx",
    "...",
    "<your key>",
    "<MODEL_API_KEY>",
    "${MODEL_API_KEY}",
    "your-key-here",
    // QA round 1 on PR #1
    '""',
    "''",
    '"changeme"',
    "xxxx",
    "XXXXXXXX",
    "YOUR_API_KEY_HERE",
    "your_api_key",
    "your-api-key",
    "insert-key-here",
    "sk-...",
    "EAAG...",
    "***",
    "Not set",
    "not given",
    "nil",
    "\u200B",
    "\u200Bchangeme",
    "$MODEL_API_KEY",
    "MODEL_API_KEY",
  ];
  for (const value of placeholders) {
    test(JSON.stringify(value), () => {
      expect(readEnv("MODEL_API_KEY", { MODEL_API_KEY: value })).toBeUndefined();
    });
  }

  for (const keep of ["sk-abc123xyz", "EAAGabc123", "todo-list-42", "x1y2z3"]) {
    test(`a real-looking value ${JSON.stringify(keep)} is kept`, () => {
      expect(readEnv("MODEL_API_KEY", { MODEL_API_KEY: keep })).toBe(keep);
    });
  }

  test("surrounding quotes and zero-width spaces are removed from a real value", () => {
    expect(readEnv("MODEL_API_KEY", { MODEL_API_KEY: ' "sk-abc123" ' })).toBe("sk-abc123");
    expect(readEnv("MODEL_API_KEY", { MODEL_API_KEY: "\u200Bsk-abc123\uFEFF" })).toBe("sk-abc123");
  });

  test("a value that merely contains a placeholder word is kept", () => {
    expect(readEnv("WHATSAPP_VERIFY_TOKEN", { WHATSAPP_VERIFY_TOKEN: "todo-list-42" })).toBe(
      "todo-list-42",
    );
  });
});

const allLines = (await Bun.file(new URL("../../.env.example", import.meta.url)).text())
  .split("\n")
  .map((l) => l.trim());
const lines = allLines.filter((l) => l !== "" && !l.startsWith("#"));

/** A line, commented or not, that sets a name to a value. */
export const hasValue = (line: string) => /^#?\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(line.trim());

describe(".env.example", () => {
  test("has names only, never a value", () => {
    for (const line of lines) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
  });

  test("no line sets a value, not even a commented one", () => {
    for (const line of allLines) expect(hasValue(line)).toBe(false);
  });

  test("the value check catches commented values and keeps plain comments", () => {
    for (const bad of ["# APP_SECRET=sk_live_x", "#APP_SECRET=x", "APP_SECRET=abc", "  # MODEL_API_KEY = k"]) expect(hasValue(bad)).toBe(true);
    for (const ok of ["APP_SECRET=", "# Names only. Put real values in your environment's secrets.", '# "off" stops every paid model call. Blank means on.', ""]) expect(hasValue(ok)).toBe(false);
  });

  test("lists exactly the names the code reads", () => {
    const names = lines.map((l) => l.slice(0, -1)).sort();
    expect(names).toEqual([...ENV_NAMES].sort());
  });
});
