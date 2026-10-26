import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAILY_CAP_USD, MAX_CALLS_PER_JOB, SpendGuard, SpendRefused } from "./spend-guard.ts";

let dir: string;
let ledgerPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spend-"));
  ledgerPath = join(dir, "ledger.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ok = (usd: number) => async () => ({ value: "done", usd });

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SpendRefused) return e.reason;
    throw e;
  }
  throw new Error("expected SpendRefused");
}

describe("kill switch", () => {
  test("STALLSNAP_PAID_CALLS=off refuses every call before it runs", async () => {
    const guard = new SpendGuard({ ledgerPath, paidCalls: "off" });
    let ran = false;
    const reason = await refusal(
      guard.paid({ jobId: "j1", what: "test", maxUsd: 0.01 }, async () => {
        ran = true;
        return { value: 1, usd: 0.01 };
      }),
    );
    expect(reason).toBe("paid-calls-off");
    expect(ran).toBe(false);
    expect(guard.spentToday()).toBe(0);
  });

  test("off is read from the environment when not passed", async () => {
    const before = process.env.STALLSNAP_PAID_CALLS;
    process.env.STALLSNAP_PAID_CALLS = "off";
    try {
      const guard = new SpendGuard({ ledgerPath });
      expect(await refusal(guard.paid({ jobId: "j", what: "t", maxUsd: 0.01 }, ok(0.01)))).toBe(
        "paid-calls-off",
      );
    } finally {
      if (before === undefined) delete process.env.STALLSNAP_PAID_CALLS;
      else process.env.STALLSNAP_PAID_CALLS = before;
    }
  });
});

describe(`${MAX_CALLS_PER_JOB} calls per job`, () => {
  test("call 61 is refused before it runs; another job still works", async () => {
    const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
    for (let i = 0; i < MAX_CALLS_PER_JOB; i++) {
      await guard.paid({ jobId: "busy", what: `call ${i}`, maxUsd: 0.001 }, ok(0.001));
    }
    expect(guard.callsForJob("busy")).toBe(60);

    let ran = false;
    const reason = await refusal(
      guard.paid({ jobId: "busy", what: "call 61", maxUsd: 0.001 }, async () => {
        ran = true;
        return { value: 1, usd: 0 };
      }),
    );
    expect(reason).toBe("job-call-cap");
    expect(ran).toBe(false);
    expect(guard.callsForJob("busy")).toBe(60);

    expect(await guard.paid({ jobId: "other", what: "x", maxUsd: 0.001 }, ok(0.001))).toBe("done");
  });

  test("the count survives a restart", async () => {
    const first = new SpendGuard({ ledgerPath, paidCalls: "on" });
    for (let i = 0; i < MAX_CALLS_PER_JOB; i++) {
      await first.paid({ jobId: "j", what: "x", maxUsd: 0.001 }, ok(0));
    }
    const second = new SpendGuard({ ledgerPath, paidCalls: "on" });
    expect(await refusal(second.paid({ jobId: "j", what: "x", maxUsd: 0.001 }, ok(0)))).toBe(
      "job-call-cap",
    );
  });
});

describe(`$${DAILY_CAP_USD} daily cap`, () => {
  test("spending exactly the cap is allowed; the next call is refused before it runs", async () => {
    const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
    for (let i = 0; i < 4; i++) {
      await guard.paid({ jobId: `j${i}`, what: "x", maxUsd: 0.5 }, ok(0.5));
    }
    expect(guard.spentToday()).toBeCloseTo(2, 10);
    let ran = false;
    const reason = await refusal(
      guard.paid({ jobId: "j9", what: "x", maxUsd: 0.01 }, async () => {
        ran = true;
        return { value: 1, usd: 0.01 };
      }),
    );
    expect(reason).toBe("daily-cap");
    expect(ran).toBe(false);
  });

  test("refuses a call whose worst case would pass the cap, even with budget left", async () => {
    const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
    await guard.paid({ jobId: "j", what: "x", maxUsd: 1.5 }, ok(1.5));
    expect(await refusal(guard.paid({ jobId: "j", what: "x", maxUsd: 0.6 }, ok(0.1)))).toBe(
      "daily-cap",
    );
    expect(await guard.paid({ jobId: "j", what: "x", maxUsd: 0.5 }, ok(0.1))).toBe("done");
  });

  test("the real cost replaces the worst case once the call ends", async () => {
    const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
    await guard.paid({ jobId: "j", what: "x", maxUsd: 1.9 }, ok(0.02));
    expect(guard.spentToday()).toBeCloseTo(0.02, 10);
  });

  test("concurrent calls can't overshoot the cap together", async () => {
    const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
    let started = 0;
    const slow = async () => {
      started++;
      await Bun.sleep(5);
      return { value: 1, usd: 0.5 };
    };
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => guard.paid({ jobId: `c${i}`, what: "x", maxUsd: 0.5 }, slow)),
    );
    expect(started).toBe(4);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(guard.spentToday()).toBeCloseTo(2, 10);
  });

  test("a call that throws is charged its worst case", async () => {
    const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
    await expect(
      guard.paid({ jobId: "j", what: "x", maxUsd: 0.3 }, async () => {
        throw new Error("network dropped after Meta billed");
      }),
    ).rejects.toThrow("network dropped");
    expect(guard.spentToday()).toBeCloseTo(0.3, 10);
  });

  test("spend survives a restart", async () => {
    const first = new SpendGuard({ ledgerPath, paidCalls: "on" });
    await first.paid({ jobId: "j", what: "x", maxUsd: 1.8 }, ok(1.8));
    const second = new SpendGuard({ ledgerPath, paidCalls: "on" });
    expect(second.spentToday()).toBeCloseTo(1.8, 10);
    expect(await refusal(second.paid({ jobId: "k", what: "x", maxUsd: 0.5 }, ok(0.5)))).toBe(
      "daily-cap",
    );
  });

  test("the cap resets at UTC midnight; per-job counts do not", async () => {
    let now = new Date("2026-10-27T23:59:00Z");
    const guard = new SpendGuard({ ledgerPath, paidCalls: "on", now: () => now });
    await guard.paid({ jobId: "j", what: "x", maxUsd: 2 }, ok(2));
    expect(await refusal(guard.paid({ jobId: "j", what: "x", maxUsd: 0.01 }, ok(0)))).toBe(
      "daily-cap",
    );
    now = new Date("2026-10-28T00:00:01Z");
    expect(guard.spentToday()).toBe(0);
    expect(guard.callsForJob("j")).toBe(1);
    expect(await guard.paid({ jobId: "j", what: "x", maxUsd: 0.5 }, ok(0.5))).toBe("done");
  });
});

describe("unreadable ledger", () => {
  test("stops paid calls instead of starting again from zero", async () => {
    writeFileSync(ledgerPath, "{not json");
    const guard = new SpendGuard({ ledgerPath, paidCalls: "on" });
    expect(await refusal(guard.paid({ jobId: "j", what: "x", maxUsd: 0.01 }, ok(0)))).toBe(
      "ledger-unreadable",
    );
  });
});
