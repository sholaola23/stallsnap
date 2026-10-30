// Thin client for the Meta Model API Responses endpoint (https://dev.meta.ai/docs/protocols/responses).
// Every call streams, and the full event list is cached on disk by request hash, so a rerun
// of the same request is free and works without a key.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Budget, costUsd, type Usage } from "./spend.ts";

export const BASE_URL = "https://api.meta.ai/v1";

export interface StreamEvent {
  type: string;
  delta?: string;
  text?: string;
  message?: string;
  response?: { usage?: Usage; error?: { message: string } | null };
  [key: string]: unknown;
}

export class MetaApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface ClientOptions {
  budget: Budget;
  apiKey?: string;
  fetch?: typeof fetch;
  cacheDir?: string;
}

export function parseSse(body: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data) as StreamEvent);
  }
  return events;
}

export function outputText(events: readonly StreamEvent[]): string {
  const done = events.filter((e) => e.type === "response.output_text.done");
  if (done.length > 0) return done.map((e) => e.text ?? "").join("");
  return events
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => e.delta ?? "")
    .join("");
}

export class MetaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir: string;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.cacheDir = options.cacheDir ?? ".cache/meta";
  }

  get budget(): Budget {
    return this.options.budget;
  }

  // The same client (key, cache, fetch) counting against another budget.
  withBudget(budget: Budget): MetaClient {
    return new MetaClient({ ...this.options, budget });
  }

  cachePath(body: Record<string, unknown>): string {
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24);
    return join(this.cacheDir, `${String(body.model)}-${hash}.json`);
  }

  // Sends one Responses request (streamed) and returns its events. Cached answers cost nothing.
  async respond(body: Record<string, unknown>, billedUnits = 1): Promise<StreamEvent[]> {
    const request: Record<string, unknown> = { ...body, stream: true };
    const path = this.cachePath(request);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as StreamEvent[];

    const model = String(request.model);
    if (this.options.budget.settings.live && !this.options.apiKey) {
      throw new MetaApiError("MODEL_API_KEY is not set, so the live call cannot be made.");
    }
    this.options.budget.allow(model);

    const response = await this.fetchImpl(`${BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(request),
    });
    const text = await response.text();
    if (!response.ok) {
      // A failed request is not billed by Meta, so nothing goes on the ledger.
      throw new MetaApiError(`Meta API ${response.status} for ${model}: ${text.slice(0, 300)}`, response.status);
    }
    const events = parseSse(text);
    const failed = events.find((e) => e.type === "response.failed" || e.type === "error");
    const completed = events.find((e) => e.type === "response.completed");
    this.options.budget.record(model, costUsd(model, completed?.response?.usage, billedUnits));
    if (failed) {
      throw new MetaApiError(`Meta API stream failed for ${model}: ${failed.message ?? failed.response?.error?.message ?? "no message"}`);
    }
    if (!completed) throw new MetaApiError(`Meta API stream for ${model} ended without response.completed`);

    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(path, JSON.stringify(events));
    return events;
  }

  // Transcribes a WAV recording with Muse Voice Transcribe (https://dev.meta.ai/docs/speech-to-text).
  // Cached by the audio and settings, like every other call.
  async transcribe(wav: Buffer, settings: Record<string, unknown>): Promise<TranscribeResult> {
    const request: Record<string, unknown> = { ...settings, audioEncoding: "WAV" };
    const model = String(request.model);
    const hash = createHash("sha256").update(JSON.stringify(request)).update(wav).digest("hex").slice(0, 24);
    const path = join(this.cacheDir, `${model}-${hash}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as TranscribeResult;

    if (this.options.budget.settings.live && !this.options.apiKey) {
      throw new MetaApiError("MODEL_API_KEY is not set, so the live call cannot be made.");
    }
    this.options.budget.allow(model);
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
    form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "note.wav");
    const response = await this.fetchImpl(`${BASE_URL}/asr/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json" },
      body: form,
    });
    const text = await response.text();
    if (!response.ok) throw new MetaApiError(`Meta API ${response.status} for ${model}: ${text.slice(0, 300)}`, response.status);
    const result = JSON.parse(text) as TranscribeResult;
    // Billed per whole second of audio processed.
    this.options.budget.record(model, costUsd(model, undefined, Math.floor((result.audioDurationMs ?? 0) / 1000)));
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(path, JSON.stringify(result));
    return result;
  }
}

export interface TranscribeResult {
  transcript: string;
  audioDurationMs?: number;
  turns?: { transcript: string; startMs: number; endMs: number }[];
}
