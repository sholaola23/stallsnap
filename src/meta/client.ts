// The one place that talks to the Meta Model API. Every call goes through
// SpendGuard.paid(). With a cache directory set (development), a request
// already made is answered from disk for free and never reaches SpendGuard.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpendGuard } from "../spend-guard.ts";

export const BASE_URL = "https://api.meta.ai/v1";

export class MetaApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Meta API ${status}: ${detail}`);
    this.name = "MetaApiError";
  }
}

export type MetaClientOptions = {
  apiKey: string;
  guard: SpendGuard;
  fetch?: typeof fetch;
  /** Development only: save each response here and replay it next time. */
  cacheDir?: string;
  baseUrl?: string;
};

type Call = { jobId: string; what: string; maxUsd: number };

export class MetaClient {
  readonly #o: Required<Omit<MetaClientOptions, "cacheDir">> & { cacheDir: string | undefined };

  constructor(opts: MetaClientOptions) {
    this.#o = { fetch: globalThis.fetch, baseUrl: BASE_URL, cacheDir: undefined, ...opts };
  }

  /** POST /responses. `usd` turns the response into its real cost. */
  responses(call: Call, body: Record<string, unknown>, usd: (res: unknown) => number): Promise<unknown> {
    const json = JSON.stringify(body);
    return this.#cached(call, `responses\n${json}`, usd, async () => {
      const res = await this.#o.fetch(`${this.#o.baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#o.apiKey}`, "content-type": "application/json" },
        body: json,
      });
      return readJson(res);
    });
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
    return this.#cached(call, key, usd, async () => {
      const form = new FormData();
      form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
      form.append("audio", new Blob([wav], { type: "audio/wav" }), "note.wav");
      const res = await this.#o.fetch(`${this.#o.baseUrl}/asr/transcribe`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#o.apiKey}`, accept: "application/json" },
        body: form,
      });
      return readJson(res);
    });
  }

  async #cached(call: Call, key: string, usd: (res: unknown) => number, send: () => Promise<unknown>): Promise<unknown> {
    const file = this.#o.cacheDir && join(this.#o.cacheDir, `${createHash("sha256").update(key).digest("hex")}.json`);
    if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const value = await this.#o.guard.paid(call, async () => {
      const res = await send();
      return { value: res, usd: usd(res) };
    });
    if (file) {
      mkdirSync(this.#o.cacheDir!, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(value));
      renameSync(`${file}.tmp`, file);
    }
    return value;
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
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
