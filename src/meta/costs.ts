// Meta Model API prices, Standard mode, from
// https://dev.meta.ai/docs/pricing-rate-limits (read 26 Oct 2026).
// Contributor mode is never used: it lets Meta train on traders' photos
// and voice notes.

export const PRICES = {
  spark: { inputPerToken: 1.25 / 1e6, cachedInputPerToken: 0.15 / 1e6, outputPerToken: 4.25 / 1e6 },
  samPerImage: 2.5 / 1000,
  voicePerHour: 0.18,
  imagePerImage: 0.01,
} as const;

export const SPARK_MODEL = "muse-spark-1.3";
export const SAM_MODEL = "sam-3.1";
export const VOICE_MODEL = "muse-voice-transcribe-1.0";
export const IMAGE_MODEL = "muse-image-1.0";

export type SparkUsage = {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
};

/** Worst case for one Spark call: every input token uncached, every output token used. */
export function sparkMaxUsd(maxInputTokens: number, maxOutputTokens: number): number {
  return maxInputTokens * PRICES.spark.inputPerToken + maxOutputTokens * PRICES.spark.outputPerToken;
}

/** Real cost from a response's usage, or NaN if the usage can't be read (SpendGuard then charges the worst case). */
export function sparkUsd(usage: unknown): number {
  const u = usage as Partial<SparkUsage> | undefined;
  const input = u?.input_tokens;
  const output = u?.output_tokens;
  if (!Number.isInteger(input) || !Number.isInteger(output) || input! < 0 || output! < 0) return Number.NaN;
  const cached = Math.min(input!, Math.max(0, u?.input_tokens_details?.cached_tokens ?? 0));
  return (
    (input! - cached) * PRICES.spark.inputPerToken +
    cached * PRICES.spark.cachedInputPerToken +
    output! * PRICES.spark.outputPerToken
  );
}

/** Voice is billed per whole second of audio. */
export function voiceUsd(durationMs: number): number {
  return (Math.floor(durationMs / 1000) / 3600) * PRICES.voicePerHour;
}
