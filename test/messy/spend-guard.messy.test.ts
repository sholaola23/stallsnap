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
    ["negative spend", JSON.stringify({ day: "2026-10-27", spentMicro: -5, jobCalls: {} })],
    ["spend as text", JSON.stringify({ day: "2026-10-27", spentMicro: "0", jobCalls: {} })],
    ["bad day", JSON.stringify({ day: "27/10/2026", spentMicro: 0, jobCalls: {} })],
    ["fractional count", JSON.stringify({ day: "2026-10-27", spentMicro: 0, jobCalls: { j: 1.5 } })],
    ["counts as array", JSON.stringify({ day: "2026-10-27", spentMicro: 0, jobCalls: [] })],
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

// QA round 1 on PR #2: each repro is kept as a test.
describe("QA round 1 on PR #2", () => {
  const counting = (counter: { n: number }, usd: number) => async () => {
    counter.n++;
    return { value: 1, usd };
  };
  const tryPaid = (g: SpendGuard, jobId: string, maxUsd: number, run: () => Promise<{ value: number; usd: number }>) =>
    g.paid({ jobId, what: "qa", maxUsd }, run).then(
      () => true,
      (e) => (e instanceof SpendRefused ? false : Promise.reject(e)),
    );

  test("two guards on one ledger share one $2 cap and both jobs' counts survive", async () => {
    const a = new SpendGuard({ ledgerPath, paidCalls: "on" });
    const b = new SpendGuard({ ledgerPath, paidCalls: "on" });
    const calls = { n: 0 };
    for (let i = 0; i < 4; i++) {
      await tryPaid(a, "j1", 0.5, counting(calls, 0.5));
      await tryPaid(b, "j2", 0.5, counting(calls, 0.5));
    }
    expect(calls.n).toBe(4);
    expect(a.spentToday()).toBeCloseTo(2, 10);
    expect(a.callsForJob("j1") + a.callsForJob("j2")).toBe(4);
    expect(a.callsForJob("j1")).toBeGreaterThan(0);
  });

  test("a call held open across UTC midnight can't wipe the new day's total", async () => {
    let now = new Date("2026-10-26T23:59:00Z");
    const g = new SpendGuard({ ledgerPath, paidCalls: "on", now: () => now });
    let release!: () => void;
    const slow = g.paid({ jobId: "slow", what: "qa", maxUsd: 2 }, () => new Promise<{ value: number; usd: number }>((r) => (release = () => r({ value: 1, usd: 0.01 }))));
    await Bun.sleep(1);
    now = new Date("2026-10-27T00:01:00Z");
    const calls = { n: 0 };
    for (let i = 0; i < 4; i++) await tryPaid(g, `d${i}`, 0.4, counting(calls, 0.4));
    release();
    await slow;
    for (let i = 0; i < 5; i++) await tryPaid(g, `e${i}`, 0.4, counting(calls, 0.4));
    // The 27th: 4 x 0.40 + the late 0.01, then at most one more 0.40 fits under $2.
    expect(calls.n).toBeLessThanOrEqual(5);
    expect(g.spentToday()).toBeLessThanOrEqual(2);
  });

  test("the clock stepping back across midnight doesn't reset the cap", async () => {
    let now = new Date("2026-10-26T23:59:59Z");
    const g = new SpendGuard({ ledgerPath, paidCalls: "on", now: () => now });
    const calls = { n: 0 };
    const spend = async () => {
      for (let i = 0; i < 2; i++) await tryPaid(g, `c${calls.n}-${i}-${now.getTime()}`, 1, counting(calls, 1));
    };
    await spend();
    now = new Date("2026-10-27T00:00:01Z");
    await spend();
    now = new Date("2026-10-26T23:59:59Z");
    await spend();
    now = new Date("2026-10-27T00:00:02Z");
    await spend();
    expect(calls.n).toBeLessThanOrEqual(4);
  });

  for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    test(`job id ${JSON.stringify(id)} gets exactly ${60} calls, and a restart still works`, async () => {
      const g = new SpendGuard({ ledgerPath, paidCalls: "on" });
      const calls = { n: 0 };
      for (let i = 0; i < 70; i++) await tryPaid(g, id, 0.0001, counting(calls, 0));
      expect(calls.n).toBe(60);
      const again = new SpendGuard({ ledgerPath, paidCalls: "on" });
      expect(again.callsForJob(id)).toBe(60);
      expect(await tryPaid(again, "other", 0.0001, counting(calls, 0))).toBe(true);
    });
  }

  test("exactly $2 is reachable in 20 x $0.10 (no float drift)", async () => {
    const g = new SpendGuard({ ledgerPath, paidCalls: "on" });
    const calls = { n: 0 };
    for (let i = 0; i < 21; i++) await tryPaid(g, `t${i}`, 0.1, counting(calls, 0.1));
    expect(calls.n).toBe(20);
  });

  test("a hanging call keeps its reservation", async () => {
    const g = new SpendGuard({ ledgerPath, paidCalls: "on" });
    void g.paid({ jobId: "hang", what: "qa", maxUsd: 1.5 }, () => new Promise<{ value: number; usd: number }>(() => {}));
    await Bun.sleep(1);
    expect(await tryPaid(g, "next", 0.6, counting({ n: 0 }, 0.6))).toBe(false);
  });

  test("the paidCalls option can't switch calls on against STALLSNAP_PAID_CALLS=off", async () => {
    const before = process.env.STALLSNAP_PAID_CALLS;
    process.env.STALLSNAP_PAID_CALLS = "off";
    try {
      const g = new SpendGuard({ ledgerPath, paidCalls: "on" });
      expect(await tryPaid(g, "j", 0.01, counting({ n: 0 }, 0))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.STALLSNAP_PAID_CALLS;
      else process.env.STALLSNAP_PAID_CALLS = before;
    }
  });
});
