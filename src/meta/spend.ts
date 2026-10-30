// Spend guard for the Meta Model API. Every paid call asks permission here first.
// Paid calls are off unless STALLSNAP_LIVE=1, so tests and CI can never bill anyone.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Prices from https://dev.meta.ai/docs/pricing-rate-limits (read 30 Oct 2026), in US dollars.
const SPARK_PER_TOKEN = { input: 1.25e-6, cachedInput: 0.15e-6, output: 4.25e-6 };
const SAM_PER_IMAGE = 0.0025;
const IMAGE_PER_PICTURE = 0.01;
const TRANSCRIBE_PER_SECOND = 0.18 / 3600;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

export function costUsd(model: string, usage: Usage | undefined, units = 1): number {
  if (model.startsWith("sam-")) return SAM_PER_IMAGE * units;
  if (model.startsWith("muse-image")) return IMAGE_PER_PICTURE * units;
  if (model.startsWith("muse-voice")) return TRANSCRIBE_PER_SECOND * units;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const input = (usage?.input_tokens ?? 0) - cached;
  const output = usage?.output_tokens ?? 0;
  return input * SPARK_PER_TOKEN.input + cached * SPARK_PER_TOKEN.cachedInput + output * SPARK_PER_TOKEN.output;
}

// Rough cost of a call before it is made, so the daily cap can refuse it up front.
export function estimateUsd(model: string): number {
  if (model.startsWith("sam-")) return SAM_PER_IMAGE;
  if (model.startsWith("muse-image")) return IMAGE_PER_PICTURE;
  if (model.startsWith("muse-voice")) return TRANSCRIBE_PER_SECOND * 120;
  return 0.02;
}

export class SpendRefused extends Error {}

export interface BudgetSettings {
  live: boolean;
  maxCalls: number;
  dailyCapUsd: number;
  ledgerPath: string;
}

function numberSetting(env: Record<string, string | undefined>, name: string, fallback: number, ceiling: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > ceiling) {
    throw new Error(`${name} must be a number above 0 and at most ${ceiling}, got "${raw}"`);
  }
  return value;
}

export function budgetFromEnv(env: Record<string, string | undefined> = process.env): BudgetSettings {
  const live = env.STALLSNAP_LIVE ?? "0";
  if (live !== "0" && live !== "1") throw new Error(`STALLSNAP_LIVE must be 0 or 1, got "${live}"`);
  return {
    live: live === "1",
    maxCalls: numberSetting(env, "STALLSNAP_MAX_CALLS", 10, 200),
    dailyCapUsd: numberSetting(env, "STALLSNAP_DAILY_CAP_USD", 2, 25),
    ledgerPath: ".cache/spend.jsonl",
  };
}

interface LedgerLine {
  at: string;
  model: string;
  usd: number;
}

export class Budget {
  private calls = 0;
  private spentThisRun = 0;

  constructor(readonly settings: BudgetSettings, private readonly now: () => Date = () => new Date()) {}

  // A fresh call count with the same settings. The daily dollar cap is still shared through the
  // ledger file, so a long-running server can count calls per message without a shared ceiling.
  forJob(): Budget {
    return new Budget(this.settings, this.now);
  }

  spentToday(): number {
    if (!existsSync(this.settings.ledgerPath)) return 0;
    const day = this.now().toISOString().slice(0, 10);
    let total = 0;
    for (const line of readFileSync(this.settings.ledgerPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as LedgerLine;
      if (entry.at.startsWith(day)) total += entry.usd;
    }
    return total;
  }

  // Throws SpendRefused before a paid call that breaks any limit.
  allow(model: string): void {
    if (!this.settings.live) {
      throw new SpendRefused(`Paid call to ${model} refused: STALLSNAP_LIVE is not 1 and there is no cached answer.`);
    }
    if (this.calls >= this.settings.maxCalls) {
      throw new SpendRefused(`Paid call to ${model} refused: this run already made ${this.calls} paid calls (STALLSNAP_MAX_CALLS).`);
    }
    const projected = this.spentToday() + estimateUsd(model);
    if (projected > this.settings.dailyCapUsd) {
      throw new SpendRefused(
        `Paid call to ${model} refused: today's spend would reach $${projected.toFixed(3)}, over STALLSNAP_DAILY_CAP_USD ($${this.settings.dailyCapUsd}).`,
      );
    }
    this.calls += 1;
  }

  record(model: string, usd: number): void {
    this.spentThisRun += usd;
    mkdirSync(dirname(this.settings.ledgerPath), { recursive: true });
    const line: LedgerLine = { at: this.now().toISOString(), model, usd };
    appendFileSync(this.settings.ledgerPath, JSON.stringify(line) + "\n");
  }

  get paidCalls(): number {
    return this.calls;
  }

  get runSpendUsd(): number {
    return this.spentThisRun;
  }
}

if (import.meta.main) {
  const budget = new Budget(budgetFromEnv());
  console.log(`Estimated Meta spend today (UTC): $${budget.spentToday().toFixed(4)}`);
}
