// The one place that talks to the Meta Model API. Every call goes through
// SpendGuard.paid(). With a cache directory set (development), a request
// already made is answered from disk for free and never reaches SpendGuard.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEnv } from "../env.ts";
import type { SpendGuard } from "../spend-guard.ts";

export const BASE_URL = "https://api.meta.ai/v1";
export const TIMEOUT_MS = 120_000; // generous: a 10-minute voice note takes a while
export const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 30_000;
// Meta's docs: back off and retry on rate limits and server errors; a 4xx other
// than 429 is permanent for that request. Status 0 is our timeout or a network failure.
const RETRYABLE = new Set([0, 429, 500, 502, 503, 504]);

export class MetaApiError extends Error {
  /** From a Retry-After header, when Meta sent one. */
  retryAfterMs: number | undefined;
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Meta API ${status}: ${detail}`);
    this.name = "MetaApiError";
  }
}

export type MetaClientOptions = {
  apiKey: string | undefined;
  guard: SpendGuard;
  fetch?: typeof fetch;
  /** Development only: save each response here and replay it next time. */
  cacheDir?: string;
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type Call = { jobId: string; what: string; maxUsd: number };

/** Retry-After as seconds or an HTTP date, in milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export class MetaClient {
  readonly #o: { apiKey: string; guard: SpendGuard; fetch: typeof fetch; cacheDir: string | undefined; baseUrl: string; timeoutMs: number; sleep: (ms: number) => Promise<void> };

  constructor(opts: MetaClientOptions) {
    // A missing or placeholder key fails here, before any paid call, never as "Bearer undefined".
    const apiKey = readEnv("MODEL_API_KEY", { MODEL_API_KEY: opts.apiKey });
    if (apiKey === undefined) throw new Error("MODEL_API_KEY is not set");
    // Each default is applied with ??, so an option passed as undefined still gets it.
    this.#o = {
      apiKey,
      guard: opts.guard,
      fetch: opts.fetch ?? globalThis.fetch,
      baseUrl: opts.baseUrl ?? BASE_URL,
      cacheDir: opts.cacheDir,
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      sleep: opts.sleep ?? ((ms) => Bun.sleep(ms)),
    };
  }

  /** POST /responses. `usd` turns the response into its real cost. */
  responses(call: Call, body: Record<string, unknown>, usd: (res: unknown) => number): Promise<unknown> {
    const json = JSON.stringify(body);
    return this.#cached(call, `responses\n${json}`, usd, () =>
      this.#send("/responses", { method: "POST", headers: { authorization: `Bearer ${this.#o.apiKey}`, "content-type": "application/json" }, body: json }),
    );
  }

  /** POST /images/edits (Muse Image) with a JSON body. */
  imagesEdit(call: Call, body: Record<string, unknown>, usd: (res: unknown) => number): Promise<unknown> {
    const json = JSON.stringify(body);
    return this.#cached(call, `images/edits\n${json}`, usd, async () => {
      const res = await this.#o.fetch(`${this.#o.baseUrl}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#o.apiKey}`, "content-type": "application/json" },
        body: json,
      });
      return readJson(res);
    });
  }

  /** POST /asr/transcribe with a WAV clip. */
  transcribe(call: Call, request: Record<string, unknown>, wav: Uint8Array, usd: (res: unknown) => number): Promise<unknown> {
    const key = `transcribe\n${JSON.stringify(request)}\n${createHash("sha256").update(wav).digest("hex")}`;
    return this.#cached(call, key, usd, () => {
      const form = new FormData();
      form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
      form.append("audio", new Blob([wav], { type: "audio/wav" }), "note.wav");
      return this.#send("/asr/transcribe", { method: "POST", headers: { authorization: `Bearer ${this.#o.apiKey}`, accept: "application/json" }, body: form });
    });
  }

  /** One HTTP request with a timeout. Timeouts and network failures become MetaApiError status 0. */
  async #send(path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#o.fetch(`${this.#o.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.#o.timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new MetaApiError(0, timedOut ? `no answer within ${this.#o.timeoutMs / 1000} s` : `network error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const err = await readJson(res).then(
        () => new MetaApiError(res.status, ""),
        (e: unknown) => e,
      );
      if (err instanceof MetaApiError) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    return readJson(res);
  }

  /**
   * Answers from the cache when it can; otherwise sends, retrying rate limits,
   * server errors and timeouts up to MAX_ATTEMPTS times with backoff. Each
   * attempt is its own paid call, so SpendGuard counts and caps every one.
   */
  async #cached(call: Call, key: string, usd: (res: unknown) => number, send: () => Promise<unknown>): Promise<unknown> {
    const file = this.#o.cacheDir && join(this.#o.cacheDir, `${createHash("sha256").update(key).digest("hex")}.json`);
    if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    let value: unknown;
    for (let attempt = 1; ; attempt++) {
      try {
        value = await this.#o.guard.paid({ ...call, what: attempt === 1 ? call.what : `${call.what} (attempt ${attempt})` }, async () => {
          const res = await send();
          return { value: res, usd: usd(res) };
        });
        break;
      } catch (e) {
        if (!(e instanceof MetaApiError) || !RETRYABLE.has(e.status) || attempt >= MAX_ATTEMPTS) throw e;
        // Meta says to wait at least Retry-After. Longer than we are willing to wait means give up now.
        if ((e.retryAfterMs ?? 0) > MAX_RETRY_WAIT_MS) throw e;
        const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 250;
        await this.#o.sleep(Math.max(backoff, e.retryAfterMs ?? 0));
      }
    }
    if (file) {
      mkdirSync(this.#o.cacheDir!, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(value));
      renameSync(`${file}.tmp`, file);
    }
    return value;
  }
}

async function readJson(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    // The body stalled past the timeout or the connection dropped mid-body.
    throw new MetaApiError(0, `response body not read: ${e instanceof Error ? e.name : String(e)}`);
  }
  if (!res.ok) throw new MetaApiError(res.status, text.slice(0, 500));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MetaApiError(res.status, `response was not JSON: ${text.slice(0, 200)}`);
  }
  // Every Meta response is a JSON object; anything else is treated as a failed call.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new MetaApiError(res.status, `response was not a JSON object: ${text.slice(0, 200)}`);
  }
  return body;
}
