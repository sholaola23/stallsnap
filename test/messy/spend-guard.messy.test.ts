// Messy-input suite: SpendGuard settings, cost figures and ledger files.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendGuard, SpendRefused, parsePaidCalls } from "../../src/spend-guard.ts";

let dir: string;
let ledgerPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spend-messy-"));
  ledgerPath = join(dir, "ledger.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("STALLSNAP_PAID_CALLS", () => {
  for (const [raw, want] of [
    [undefined, "on"],
    ["", "on"],
    ["  ", "on"],
    ["on", "on"],
    ["ON", "on"],
    ["off", "off"],
    [" OFF ", "off"],
    ["Off\n", "off"],
  ] as const) {
    test(`${JSON.stringify(raw)} is ${want}`, () => expect(parsePaidCalls(raw)).toBe(want));
  }

  // A typo must stop start-up, never silently leave paid calls on.
  for (const raw of ["0", "false", "no", "disabled", "of", "0ff", "off;", "N/A", "o f f"]) {
    test(`${JSON.stringify(raw)} stops start-up`, () => expect(() => parsePaidCalls(raw)).toThrow());
  }
});

describe("maxUsd must be a positive, finite number", () => {
  for (const bad of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.01" as unknown as number]) {
    test(String(bad), async () => {
      const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
      let ran = false;
      await expect(
        guard.paid({ jobId: "j", what: "x", maxUsd: bad }, async () => {
          ran = true;
          return { value: 1, usd: 0 };
        }),
      ).rejects.toThrow("maxUsd");
      expect(ran).toBe(false);
      expect(guard.callsForJob("j")).toBe(0);
    });
  }
});

test("a blank jobId is refused", async () => {
  const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
  await expect(
    guard.paid({ jobId: "  ", what: "x", maxUsd: 0.01 }, async () => ({ value: 1, usd: 0 })),
  ).rejects.toThrow("jobId");
});

describe("a real cost that can't be read is charged at the worst case", () => {
  for (const usd of [Number.NaN, -1, Number.POSITIVE_INFINITY, undefined, "0.01"]) {
    test(String(usd), async () => {
      const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
      await guard.paid({ jobId: "j", what: "x", maxUsd: 0.25 }, async () => ({
        value: 1,
        usd: usd as number,
      }));
      expect(guard.spentToday()).toBeCloseTo(0.25, 10);
    });
  }
});

describe("damaged ledger files stop paid calls", () => {
  for (const [name, body] of [
    ["empty file", ""],
    ["garbage", "\u0000\u0001"],
    ["array", "[]"],
    ["null", "null"],
    ["negative spend", JSON.stringify({ day: "2026-10-27", spentUsd: -5, jobCalls: {} })],
    ["spend as text", JSON.stringify({ day: "2026-10-27", spentUsd: "0", jobCalls: {} })],
    ["bad day", JSON.stringify({ day: "27/10/2026", spentUsd: 0, jobCalls: {} })],
    ["fractional count", JSON.stringify({ day: "2026-10-27", spentUsd: 0, jobCalls: { j: 1.5 } })],
    ["counts as array", JSON.stringify({ day: "2026-10-27", spentUsd: 0, jobCalls: [] })],
  ] as const) {
    test(name, async () => {
      writeFileSync(ledgerPath, body);
      const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
      let reason = "";
      try {
        await guard.paid({ jobId: "j", what: "x", maxUsd: 0.01 }, async () => ({ value: 1, usd: 0 }));
      } catch (e) {
        if (e instanceof SpendRefused) reason = e.reason;
      }
      expect(reason).toBe("ledger-unreadable");
    });
  }
});
