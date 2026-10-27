// Messy-input suite: the one reply to someone who isn't a trader. Once per number per
// 24 hours, across restarts, and the stored file never holds the number or the message.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STRANGER_GAP_MS, StrangerReplies } from "../../src/whatsapp/strangers.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "strangers-"));
  path = join(dir, "strangers.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("StrangerReplies", () => {
  test("once per number, then again after 24 hours", () => {
    let now = 1_000_000;
    const r = new StrangerReplies(path, () => now);
    expect(r.claim("447700900999")).toBe(true);
    expect(r.claim("447700900999")).toBe(false);
    expect(r.claim("2348099999999")).toBe(true);
    now += STRANGER_GAP_MS - 1;
    expect(r.claim("447700900999")).toBe(false);
    now += 1;
    expect(r.claim("447700900999")).toBe(true);
  });
  test("a restart doesn't send it twice", () => {
    expect(new StrangerReplies(path, () => 5).claim("447700900999")).toBe(true);
    expect(new StrangerReplies(path, () => 6).claim("447700900999")).toBe(false);
  });
  test("the file holds no phone number", () => {
    new StrangerReplies(path, () => 5).claim("447700900999");
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("447700900999");
    expect(text).not.toContain("900999");
  });
  test("a damaged or odd file is treated as empty, not a crash", () => {
    for (const bad of ["{", "null", "[1,2]", '{"x":"y"}']) {
      writeFileSync(path, bad);
      expect(new StrangerReplies(path, () => 5).claim("447700900999")).toBe(true);
    }
  });
});
