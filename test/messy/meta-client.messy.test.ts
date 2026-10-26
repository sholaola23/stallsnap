// Messy-input suite: Meta API failures and oversized voice notes (QA round 1 on PR #4).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ATTEMPTS, MetaApiError, MetaClient, parseRetryAfter } from "../../src/meta/client.ts";
import { MAX_AUDIO_BYTES, VoiceNoteError, toWav, transcribe } from "../../src/pipeline/voice.ts";
import { SpendGuard, SpendRefused } from "../../src/spend-guard.ts";

let dir: string;
let guard: SpendGuard;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meta-messy-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = { jobId: "j", what: "t", maxUsd: 0.01 };

/** A fake Meta that answers each request in turn from `answers`. */
function scripted(answers: (() => Response | Promise<Response>)[], opts: { timeoutMs?: number } = {}) {
  let n = 0;
  const waits: number[] = [];
  const client = new MetaClient({
    apiKey: "k-test",
    guard,
    timeoutMs: opts.timeoutMs,
    sleep: async (ms) => void waits.push(ms),
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      const answer = answers[Math.min(n++, answers.length - 1)]!;
      // Honour the abort signal like real fetch does.
      return await new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
        Promise.resolve(answer()).then(resolve, reject);
      });
    }) as typeof fetch,
  });
  return { client, waits, count: () => n };
}
const ok = () => new Response(JSON.stringify({ transcript: "rice na 6k", audioDurationMs: 1000 }));
const status = (code: number, headers: Record<string, string> = {}) => () => new Response('{"error":{"message":"x"}}', { status: code, headers });

describe("retries", () => {
  test("429 with Retry-After: 1, then 200: two requests, waited at least 1 s", async () => {
    const f = scripted([status(429, { "retry-after": "1" }), ok]);
    expect(await f.client.responses(call, {}, () => 0)).toMatchObject({ transcript: "rice na 6k" });
    expect(f.count()).toBe(2);
    expect(f.waits[0]!).toBeGreaterThanOrEqual(1000);
  });

  test("Retry-After as an HTTP date is read", () => {
    const now = Date.parse("Mon, 26 Oct 2026 17:00:00 GMT");
    expect(parseRetryAfter("Mon, 26 Oct 2026 17:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("2", now)).toBe(2000);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  for (const code of [500, 503]) {
    test(`${code} forever stops at ${MAX_ATTEMPTS} attempts, each charged its worst case`, async () => {
      const f = scripted([status(code)]);
      await expect(f.client.responses(call, {}, () => 0)).rejects.toBeInstanceOf(MetaApiError);
      expect(f.count()).toBe(MAX_ATTEMPTS);
      expect(guard.callsForJob("j")).toBe(MAX_ATTEMPTS);
      expect(guard.spentToday()).toBeCloseTo(0.01 * MAX_ATTEMPTS, 10);
    });
  }

  for (const code of [400, 401, 413]) {
    test(`${code} is not retried`, async () => {
      const f = scripted([status(code), ok]);
      await expect(f.client.responses(call, {}, () => 0)).rejects.toMatchObject({ status: code });
      expect(f.count()).toBe(1);
    });
  }

  test("a long Retry-After is capped at 30 s", async () => {
    const f = scripted([status(429, { "retry-after": "3600" }), ok]);
    await f.client.responses(call, {}, () => 0);
    expect(f.waits[0]!).toBeLessThanOrEqual(30_000);
  });
});

describe("timeouts", () => {
  test("a request that never answers times out, its reservation settles, and the next call isn't blocked", async () => {
    const f = scripted([() => new Promise<Response>(() => {})], { timeoutMs: 20 });
    const err = await f.client.responses({ ...call, maxUsd: 0.6 }, {}, () => 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).status).toBe(0);
    expect(f.count()).toBe(MAX_ATTEMPTS);
    // 3 x $0.60 held at worst case = $1.80; a $0.10 call still fits under $2.
    const g = scripted([ok]);
    await expect(g.client.responses({ ...call, jobId: "next", maxUsd: 0.1 }, {}, () => 0)).resolves.toBeDefined();
  });
});

describe("the API key", () => {
  for (const key of [undefined, "", "   ", "changeme", '""', "your-api-key"]) {
    test(`${JSON.stringify(key)} fails before any request or spend`, () => {
      let fetched = 0;
      expect(() => new MetaClient({ apiKey: key, guard, fetch: (async () => (fetched++, new Response("{}"))) as unknown as typeof fetch })).toThrow("MODEL_API_KEY is not set");
      expect(fetched).toBe(0);
      expect(guard.spentToday()).toBe(0);
    });
  }
});

test("the kill switch stops the call with no request (regression)", async () => {
  const off = new SpendGuard({ ledgerPath: join(dir, "off.json"), paidCalls: "off" });
  let fetched = 0;
  const client = new MetaClient({ apiKey: "k", guard: off, fetch: (async () => (fetched++, ok())) as unknown as typeof fetch });
  await expect(client.responses(call, {}, () => 0)).rejects.toBeInstanceOf(SpendRefused);
  expect(fetched).toBe(0);
});

describe("oversized voice notes", () => {
  test("a file over 16 MB is refused before decoding", async () => {
    const start = Date.now();
    await expect(toWav(new Uint8Array(MAX_AUDIO_BYTES + 1))).rejects.toMatchObject({ reason: "too-long" });
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("an 11-minute note stops decoding at 601 s and is refused before any paid call", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "long-"));
    const file = join(tmp, "long.mp3");
    const p = Bun.spawn(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "660", "-c:a", "libmp3lame", "-b:a", "8k", file]);
    expect(await p.exited).toBe(0);
    const wav = await toWav(new Uint8Array(readFileSync(file)));
    rmSync(tmp, { recursive: true, force: true });
    expect(wav.durationMs).toBeLessThanOrEqual(601_000);
    expect(wav.durationMs).toBeGreaterThan(600_000);
    let fetched = 0;
    const client = new MetaClient({ apiKey: "k", guard, fetch: (async () => (fetched++, ok())) as unknown as typeof fetch });
    await expect(transcribe(client, "j", wav, [])).rejects.toBeInstanceOf(VoiceNoteError);
    expect(fetched).toBe(0);
  });
});
