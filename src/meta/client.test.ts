import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Budget, budgetFromEnv, costUsd, SpendRefused } from "./spend.ts";
import { MetaApiError, MetaClient, outputText, parseSse } from "./client.ts";
import { fakeFetch, testBudget, testClient, textStream } from "../test/fakes.ts";

const body = { model: "muse-spark-1.3", input: "Reply with: ready" };

describe("Meta client", () => {
  test("a repeated request is answered from the cache and costs nothing", async () => {
    const { client, calls, budget } = testClient({ "muse-spark-1.3": textStream("ready") });
    expect(outputText(await client.respond(body))).toBe("ready");
    expect(outputText(await client.respond(body))).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(budget.paidCalls).toBe(1);
  });

  test("always streams", async () => {
    const { client, calls } = testClient({ "muse-spark-1.3": textStream("ready") });
    await client.respond(body);
    expect(calls[0]!.body.stream).toBe(true);
  });

  test("an HTTP error is thrown, not cached and not put on the ledger", async () => {
    const { client, budget } = testClient({ "muse-spark-1.3": 500 });
    await expect(client.respond(body)).rejects.toBeInstanceOf(MetaApiError);
    expect(budget.spentToday()).toBe(0);
  });

  test("a failed stream is billed but thrown", async () => {
    const failed = `data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "boom" } } })}\n\n`;
    const { client } = testClient({ "muse-spark-1.3": failed });
    await expect(client.respond(body)).rejects.toThrow("boom");
  });

  test("a stream that stops early is an error", async () => {
    const cut = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "rea" })}\n\n`;
    const { client } = testClient({ "muse-spark-1.3": cut });
    await expect(client.respond(body)).rejects.toThrow("without response.completed");
  });

  test("with paid calls off, an uncached request never reaches the network", async () => {
    const budget = testBudget({ live: false });
    const { client, calls } = testClient({ "muse-spark-1.3": textStream("ready") }, budget);
    await expect(client.respond(body)).rejects.toBeInstanceOf(SpendRefused);
    expect(calls).toHaveLength(0);
  });

  test("live with no key fails before spending a call", async () => {
    const fake = fakeFetch({});
    const budget = testBudget();
    const client = new MetaClient({ budget, fetch: fake.fetch, cacheDir: "/tmp/stallsnap-nokey" });
    await expect(client.respond(body)).rejects.toThrow("MODEL_API_KEY");
    expect(budget.paidCalls).toBe(0);
  });

  test("the call cap stops the next paid call", async () => {
    const budget = testBudget({ maxCalls: 1 });
    const { client } = testClient({ "muse-spark-1.3": textStream("ready") }, budget);
    await client.respond(body);
    await expect(client.respond({ ...body, input: "again" })).rejects.toThrow("STALLSNAP_MAX_CALLS");
  });

  test("the daily cap refuses a call that would pass it", async () => {
    const budget = testBudget({ dailyCapUsd: 0.03 });
    budget.record("muse-spark-1.3", 0.02);
    const { client, calls } = testClient({ "muse-spark-1.3": textStream("ready") }, budget);
    await expect(client.respond(body)).rejects.toThrow("STALLSNAP_DAILY_CAP_USD");
    expect(calls).toHaveLength(0);
  });

  test("yesterday's spend doesn't count against today", () => {
    const budget = testBudget();
    budget.record("muse-spark-1.3", 5);
    const tomorrow = new Budget(budget.settings, () => new Date(Date.now() + 86_400_000));
    expect(tomorrow.spentToday()).toBe(0);
    expect(readFileSync(budget.settings.ledgerPath, "utf8")).toContain('"usd":5');
  });

  test("parses SSE with comments, blank lines and [DONE]", () => {
    const events = parseSse(`: keep-alive\n\nevent: x\ndata: {"type":"a"}\n\ndata: [DONE]\n`);
    expect(events).toEqual([{ type: "a" }]);
  });
});

describe("spend settings", () => {
  test("paid calls are off by default", () => {
    expect(budgetFromEnv({}).live).toBe(false);
  });

  test("bad values stop start-up instead of lifting a cap", () => {
    for (const env of [
      { STALLSNAP_LIVE: "yes" },
      { STALLSNAP_MAX_CALLS: "lots" },
      { STALLSNAP_MAX_CALLS: "-1" },
      { STALLSNAP_DAILY_CAP_USD: "1000" },
      { STALLSNAP_DAILY_CAP_USD: "O.5" },
    ]) {
      expect(() => budgetFromEnv(env)).toThrow();
    }
  });

  test("costs use Meta's published prices", () => {
    expect(costUsd("sam-3.1", undefined)).toBe(0.0025);
    expect(costUsd("muse-spark-1.3", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(1.25);
    expect(
      costUsd("muse-spark-1.3", { input_tokens: 1_000_000, output_tokens: 1_000_000, input_tokens_details: { cached_tokens: 1_000_000 } }),
    ).toBeCloseTo(0.15 + 4.25);
  });
});
