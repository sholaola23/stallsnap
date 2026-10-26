import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendGuard, SpendRefused } from "../spend-guard.ts";
import { MetaApiError, MetaClient } from "./client.ts";
import { sparkMaxUsd, sparkUsd, voiceUsd } from "./costs.ts";
import { fakeMeta } from "./test-fakes.ts";

let dir: string;
let guard: SpendGuard;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meta-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const usage = { input_tokens: 1000, output_tokens: 500, input_tokens_details: { cached_tokens: 0 } };
const call = { jobId: "job1", what: "spark", maxUsd: sparkMaxUsd(20_000, 16_000) };

describe("costs", () => {
  test("Spark cost from usage, with cached input at the cached rate", () => {
    expect(sparkUsd(usage)).toBeCloseTo(1000 * 1.25e-6 + 500 * 4.25e-6, 12);
    expect(sparkUsd({ input_tokens: 1000, output_tokens: 0, input_tokens_details: { cached_tokens: 400 } })).toBeCloseTo(
      600 * 1.25e-6 + 400 * 0.15e-6,
      12,
    );
  });
  test("usage that can't be read gives NaN, so SpendGuard charges the worst case", () => {
    for (const u of [undefined, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: "10", output_tokens: 1 }]) {
      expect(sparkUsd(u)).toBeNaN();
    }
  });
  test("voice is billed per whole second at $0.18 an hour", () => {
    expect(voiceUsd(3_600_000)).toBeCloseTo(0.18, 12);
    expect(voiceUsd(1_999)).toBeCloseTo(0.18 / 3600, 12);
  });
});

describe("MetaClient", () => {
  test("sends the key as a bearer token and records the real cost", async () => {
    const meta = fakeMeta(() => ({ output: [], usage }));
    const client = new MetaClient({ apiKey: "k-test", guard, fetch: meta.fetch });
    await client.responses(call, { model: "muse-spark-1.3", input: "hi" }, (r) => sparkUsd((r as { usage: unknown }).usage));
    expect(meta.calls[0]!.url).toBe("https://api.meta.ai/v1/responses");
    expect(meta.calls[0]!.headers.get("authorization")).toBe("Bearer k-test");
    expect(guard.spentToday()).toBeCloseTo(sparkUsd(usage), 12);
    expect(guard.callsForJob("job1")).toBe(1);
  });

  test("an API error throws MetaApiError and is charged its worst case", async () => {
    const meta = fakeMeta(() => new Response('{"error":{"message":"bad prompt"}}', { status: 400 }));
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch });
    await expect(client.responses(call, { input: "x" }, () => 0)).rejects.toBeInstanceOf(MetaApiError);
    expect(guard.spentToday()).toBeCloseTo(call.maxUsd, 12);
  });

  test("with a cache, a repeated request is free and never reaches the API or SpendGuard", async () => {
    const meta = fakeMeta(() => ({ output: [], usage }));
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch, cacheDir: join(dir, "cache") });
    const usd = (r: unknown) => sparkUsd((r as { usage: unknown }).usage);
    const a = await client.responses(call, { input: "same" }, usd);
    const b = await client.responses(call, { input: "same" }, usd);
    expect(b).toEqual(a);
    expect(meta.calls).toHaveLength(1);
    expect(guard.callsForJob("job1")).toBe(1);
    await client.responses(call, { input: "different" }, usd);
    expect(meta.calls).toHaveLength(2);
  });

  test("a refused call never reaches the API", async () => {
    const meta = fakeMeta(() => ({}));
    const off = new SpendGuard({ ledgerPath: join(dir, "off.json"), paidCalls: "off" });
    const client = new MetaClient({ apiKey: "k", guard: off, fetch: meta.fetch });
    await expect(client.responses(call, { input: "x" }, () => 0)).rejects.toBeInstanceOf(SpendRefused);
    expect(meta.calls).toHaveLength(0);
  });
});
