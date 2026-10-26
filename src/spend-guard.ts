// SpendGuard: every paid Meta API call goes through `paid()`.
//
// It refuses a call before it is made when:
// - STALLSNAP_PAID_CALLS=off (the kill switch),
// - the job has already made MAX_CALLS_PER_JOB calls, or
// - today's spend plus the call's worst-case cost would pass DAILY_CAP_USD.
//
// The worst case is reserved before the call starts, so calls running at the
// same time can't overshoot the cap together. When the call finishes, the
// reservation is swapped for the real cost. A call that throws keeps its
// worst case, since Meta may have billed it. Each retry of a call must be its
// own paid() call, so it is counted and capped too.
//
// The ledger on disk is the only copy: every reserve and settle reads it,
// changes it and writes it back while holding a lock file, so two guards or
// two processes on one ledger share one cap. Money is counted in whole
// micro-dollars, so $2 is exactly $2. The day rolls over at UTC midnight and
// only forwards: a clock stepping back never resets the cap. A ledger that
// can't be read stops every paid call rather than starting again from zero.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DAILY_CAP_USD = 2;
export const MAX_CALLS_PER_JOB = 60;
export const DEFAULT_LEDGER_PATH = ".data/spend-ledger.json";

const MICRO = 1_000_000;
const CAP_MICRO = DAILY_CAP_USD * MICRO;
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export type RefusalReason = "paid-calls-off" | "job-call-cap" | "daily-cap" | "ledger-unreadable";

export class SpendRefused extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "SpendRefused";
  }
}

/** Parses STALLSNAP_PAID_CALLS. Unset or blank means on; anything but on/off stops start-up. */
export function parsePaidCalls(raw: string | undefined): "on" | "off" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "on") return "on";
  if (v === "off") return "off";
  throw new Error(`STALLSNAP_PAID_CALLS takes "on" or "off" only (it was ${JSON.stringify(raw)})`);
}

type Ledger = {
  day: string; // UTC date, YYYY-MM-DD
  spentMicro: number; // settled costs plus open reservations, for `day`
  jobCalls: Record<string, number>; // prototype-free
};

export type PaidCall = {
  jobId: string;
  /** Short label for the log, for example "sam-3.1 cutout". */
  what: string;
  /** Most this call can cost, in US dollars. */
  maxUsd: number;
};

export type PaidResult<T> = { value: T; usd: number };

export type SpendGuardOptions = {
  ledgerPath: string;
  /** "off" turns paid calls off. It can't turn them on against STALLSNAP_PAID_CALLS=off. */
  paidCalls?: "on" | "off";
  now?: () => Date;
};

class LedgerUnreadable extends Error {}

const isCost = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const toMicro = (usd: number) => Math.ceil(usd * MICRO - 1e-6);
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class SpendGuard {
  readonly #path: string;
  readonly #lock: string;
  readonly #paidCalls: "on" | "off";
  readonly #now: () => Date;

  constructor(opts: SpendGuardOptions) {
    this.#path = opts.ledgerPath;
    this.#lock = `${opts.ledgerPath}.lock`;
    const fromEnv = parsePaidCalls(process.env.STALLSNAP_PAID_CALLS);
    this.#paidCalls = opts.paidCalls === "off" || fromEnv === "off" ? "off" : "on";
    this.#now = opts.now ?? (() => new Date());
  }

  /** Runs one paid call, or throws SpendRefused before it starts. */
  async paid<T>(call: PaidCall, run: () => Promise<PaidResult<T>>): Promise<T> {
    if (!call.jobId.trim()) throw new Error("paid() needs a jobId");
    if (!isCost(call.maxUsd) || call.maxUsd === 0) {
      throw new Error(`paid() needs a positive maxUsd for ${call.what}, got ${call.maxUsd}`);
    }
    const reserved = Math.max(1, toMicro(call.maxUsd)); // at least one micro-dollar, so a tiny maxUsd still counts
    const day = this.#reserve(call, reserved);
    let settled = reserved;
    try {
      const result = await run();
      if (isCost(result.usd)) {
        settled = toMicro(result.usd);
        if (settled > reserved) console.warn(`SpendGuard: ${call.what} cost $${result.usd}, more than its worst case $${call.maxUsd}`);
      }
      return result.value;
    } finally {
      this.#settle(day, reserved, settled);
    }
  }

  /** Today's spend in US dollars, including calls still running. NaN if the ledger can't be read. */
  spentToday(): number {
    try {
      const l = this.#read();
      return l.day >= utcDay(this.#now()) ? l.spentMicro / MICRO : 0;
    } catch {
      return Number.NaN;
    }
  }

  callsForJob(jobId: string): number {
    try {
      const l = this.#read();
      return Object.hasOwn(l.jobCalls, jobId) ? l.jobCalls[jobId]! : 0;
    } catch {
      return 0;
    }
  }

  /** Checks the limits and records the reservation, all under the lock. Returns the day it was charged to. */
  #reserve(call: PaidCall, reserved: number): string {
    if (this.#paidCalls === "off") {
      throw new SpendRefused("paid-calls-off", `Paid calls are switched off by STALLSNAP_PAID_CALLS, so ${call.what} was not made`);
    }
    return this.#update((l) => {
      const calls = Object.hasOwn(l.jobCalls, call.jobId) ? l.jobCalls[call.jobId]! : 0;
      if (calls >= MAX_CALLS_PER_JOB) {
        throw new SpendRefused("job-call-cap", `Job ${call.jobId} has made ${calls} paid calls, the limit is ${MAX_CALLS_PER_JOB}: ${call.what}`);
      }
      if (l.spentMicro + reserved > CAP_MICRO) {
        throw new SpendRefused(
          "daily-cap",
          `Daily cap $${DAILY_CAP_USD} would be passed: spent $${(l.spentMicro / MICRO).toFixed(4)}, this call up to $${call.maxUsd}: ${call.what}`,
        );
      }
      l.jobCalls[call.jobId] = calls + 1;
      l.spentMicro += reserved;
      return l.day;
    });
  }

  /** Swaps a reservation for the real cost. If the day has moved on, the cost is added to the new day. */
  #settle(day: string, reserved: number, settled: number): void {
    try {
      this.#update((l) => {
        l.spentMicro = l.day === day ? Math.max(0, l.spentMicro - reserved + settled) : l.spentMicro + settled;
      });
    } catch {
      // The reservation stays charged: the safe direction.
    }
  }

  /** Runs `change` on today's ledger under the lock and saves it. */
  #update<R>(change: (l: Ledger) => R): R {
    this.#acquire();
    try {
      let l: Ledger;
      try {
        l = this.#read();
      } catch {
        throw new SpendRefused("ledger-unreadable", `Spend ledger at ${this.#path} can't be read; paid calls are stopped`);
      }
      const today = utcDay(this.#now());
      if (today > l.day) {
        l.day = today;
        l.spentMicro = 0;
      }
      const out = change(l);
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(`${this.#path}.tmp`, JSON.stringify(l));
      renameSync(`${this.#path}.tmp`, this.#path);
      return out;
    } finally {
      this.#release();
    }
  }

  #read(): Ledger {
    if (!existsSync(this.#path)) return { day: utcDay(this.#now()), spentMicro: 0, jobCalls: Object.create(null) };
    const data: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new LedgerUnreadable();
    const { day, spentMicro, jobCalls } = data as Record<string, unknown>;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new LedgerUnreadable();
    if (!Number.isSafeInteger(spentMicro) || (spentMicro as number) < 0) throw new LedgerUnreadable();
    if (typeof jobCalls !== "object" || jobCalls === null || Array.isArray(jobCalls)) throw new LedgerUnreadable();
    const counts: Record<string, number> = Object.create(null);
    for (const [job, n] of Object.entries(jobCalls)) {
      if (!Number.isSafeInteger(n) || (n as number) < 0) throw new LedgerUnreadable();
      counts[job] = n as number;
    }
    return { day, spentMicro: spentMicro as number, jobCalls: counts };
  }

  #acquire(): void {
    mkdirSync(dirname(this.#lock), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(this.#lock, "wx"));
        return;
      } catch {
        // A lock left by a crashed process is broken after STALE_LOCK_MS.
        try {
          if (Date.now() - statSync(this.#lock).mtimeMs > STALE_LOCK_MS) unlinkSync(this.#lock);
        } catch {
          // gone already
        }
        if (Date.now() > deadline) throw new SpendRefused("ledger-unreadable", `Spend ledger at ${this.#path} is locked; paid calls are stopped`);
        sleepSync(5);
      }
    }
  }

  #release(): void {
    try {
      unlinkSync(this.#lock);
    } catch {
      // already gone
    }
  }
}

// `bun src/spend-guard.ts` prints today's spend from the default ledger.
if (import.meta.main) {
  const spent = new SpendGuard({ ledgerPath: DEFAULT_LEDGER_PATH }).spentToday();
  console.log(
    Number.isNaN(spent)
      ? `Ledger at ${DEFAULT_LEDGER_PATH} can't be read; paid calls are stopped.`
      : `Spent today (UTC): $${spent.toFixed(4)} of $${DAILY_CAP_USD}`,
  );
}
