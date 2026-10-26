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
// worst case, since Meta may have billed it anyway.
//
// Spend and per-job counts are written to a ledger file after every change,
// so a restart can't reset the cap. A ledger that can't be read stops every
// paid call rather than starting again from zero.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DAILY_CAP_USD = 2;
export const DEFAULT_LEDGER_PATH = ".data/spend-ledger.json";
export const MAX_CALLS_PER_JOB = 60;

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
  throw new Error(`STALLSNAP_PAID_CALLS must be "on" or "off", got ${JSON.stringify(raw)}`);
}

type Ledger = {
  day: string; // UTC date, YYYY-MM-DD
  spentUsd: number; // settled costs plus open reservations, for `day`
  jobCalls: Record<string, number>;
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
  paidCalls?: "on" | "off";
  now?: () => Date;
};

function isCost(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class SpendGuard {
  readonly #path: string;
  readonly #paidCalls: "on" | "off";
  readonly #now: () => Date;
  #ledger: Ledger | undefined;

  constructor(opts: SpendGuardOptions) {
    this.#path = opts.ledgerPath;
    this.#paidCalls = opts.paidCalls ?? parsePaidCalls(process.env.STALLSNAP_PAID_CALLS);
    this.#now = opts.now ?? (() => new Date());
    this.#ledger = this.#load();
  }

  /** Runs one paid call, or throws SpendRefused before it starts. */
  async paid<T>(call: PaidCall, run: () => Promise<PaidResult<T>>): Promise<T> {
    if (!call.jobId.trim()) throw new Error("paid() needs a jobId");
    if (!isCost(call.maxUsd) || call.maxUsd === 0) {
      throw new Error(`paid() needs a positive maxUsd for ${call.what}, got ${call.maxUsd}`);
    }

    // Check and reserve with no await in between, so concurrent calls see
    // each other's reservations.
    const ledger = this.#reserve(call);
    let settled = call.maxUsd;
    try {
      const result = await run();
      if (isCost(result.usd)) settled = result.usd;
      return result.value;
    } finally {
      ledger.spentUsd = Math.max(0, ledger.spentUsd - call.maxUsd + settled);
      this.#save(ledger);
    }
  }

  /** Today's spend in US dollars, including calls still running. */
  spentToday(): number {
    const ledger = this.#current();
    return ledger ? ledger.spentUsd : Number.NaN;
  }

  callsForJob(jobId: string): number {
    return this.#current()?.jobCalls[jobId] ?? 0;
  }

  #reserve(call: PaidCall): Ledger {
    if (this.#paidCalls === "off") {
      throw new SpendRefused("paid-calls-off", `Paid calls are off (STALLSNAP_PAID_CALLS=off): ${call.what}`);
    }
    const ledger = this.#current();
    if (!ledger) {
      throw new SpendRefused("ledger-unreadable", `Spend ledger at ${this.#path} can't be read; paid calls are stopped`);
    }
    const calls = ledger.jobCalls[call.jobId] ?? 0;
    if (calls >= MAX_CALLS_PER_JOB) {
      throw new SpendRefused(
        "job-call-cap",
        `Job ${call.jobId} has made ${calls} paid calls, the limit is ${MAX_CALLS_PER_JOB}: ${call.what}`,
      );
    }
    if (ledger.spentUsd + call.maxUsd > DAILY_CAP_USD) {
      throw new SpendRefused(
        "daily-cap",
        `Daily cap $${DAILY_CAP_USD} would be passed: spent $${ledger.spentUsd.toFixed(4)}, this call up to $${call.maxUsd}: ${call.what}`,
      );
    }
    ledger.jobCalls[call.jobId] = calls + 1;
    ledger.spentUsd += call.maxUsd;
    this.#save(ledger);
    return ledger;
  }

  /** The ledger for today (rolling over at UTC midnight), or undefined if unreadable. */
  #current(): Ledger | undefined {
    const ledger = this.#ledger;
    if (!ledger) return undefined;
    const today = utcDay(this.#now());
    if (ledger.day !== today) {
      ledger.day = today;
      ledger.spentUsd = 0;
    }
    return ledger;
  }

  #load(): Ledger | undefined {
    if (!existsSync(this.#path)) return { day: utcDay(this.#now()), spentUsd: 0, jobCalls: {} };
    try {
      const data: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (typeof data !== "object" || data === null) return undefined;
      const { day, spentUsd, jobCalls } = data as Record<string, unknown>;
      if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
      if (!isCost(spentUsd)) return undefined;
      if (typeof jobCalls !== "object" || jobCalls === null || Array.isArray(jobCalls)) return undefined;
      const counts: Record<string, number> = {};
      for (const [job, n] of Object.entries(jobCalls)) {
        if (!Number.isInteger(n) || (n as number) < 0) return undefined;
        counts[job] = n as number;
      }
      return { day, spentUsd, jobCalls: counts };
    } catch {
      return undefined;
    }
  }

  #save(ledger: Ledger): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger));
    renameSync(tmp, this.#path);
  }
}

// `bun src/spend-guard.ts` prints today's spend from the default ledger.
if (import.meta.main) {
  const guard = new SpendGuard({ ledgerPath: DEFAULT_LEDGER_PATH, paidCalls: "on" });
  const spent = guard.spentToday();
  console.log(
    Number.isNaN(spent)
      ? `Ledger at ${DEFAULT_LEDGER_PATH} can't be read; paid calls are stopped.`
      : `Spent today (UTC): $${spent.toFixed(4)} of $${DAILY_CAP_USD}`,
  );
}
