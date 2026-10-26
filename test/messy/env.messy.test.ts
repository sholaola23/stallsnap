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
  ];
  for (const value of placeholders) {
    test(JSON.stringify(value), () => {
      expect(readEnv("MODEL_API_KEY", { MODEL_API_KEY: value })).toBeUndefined();
    });
  }

  test("a value that merely contains a placeholder word is kept", () => {
    expect(readEnv("WHATSAPP_VERIFY_TOKEN", { WHATSAPP_VERIFY_TOKEN: "todo-list-42" })).toBe(
      "todo-list-42",
    );
  });
});

const lines = (await Bun.file(new URL("../../.env.example", import.meta.url)).text())
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("#"));

describe(".env.example", () => {
  test("has names only, never a value", () => {
    for (const line of lines) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
  });

  test("lists exactly the names the code reads", () => {
    const names = lines.map((l) => l.slice(0, -1)).sort();
    expect(names).toEqual([...ENV_NAMES].sort());
  });
});
