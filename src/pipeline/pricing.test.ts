import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../meta/client.ts";
import { SparkError } from "../meta/spark.ts";
import { SpendGuard } from "../spend-guard.ts";
import { MAX_TURNS, priceItems } from "./pricing.ts";
import { flag, scriptedSpark, setPrice } from "./test-spark.ts";

let dir: string;
let guard: SpendGuard;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pricing-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const items = [
  { item: 1, name: "Peak milk tin" },
  { item: 2, name: "Milo sachet" },
  { item: 3, name: "Indomie pack" },
];
const said = ["Peak milk na 650. Milo, hundred hundred naira, one one. Milo strip na 1,000... no no, the sachet na 100."];
const run = (turns: Parameters<typeof scriptedSpark>[0], s = said) => {
  const spark = scriptedSpark(turns);
  return { spark, result: priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "job1", items, s) };
};

test("prices what the trader said, asks about the rest, and stops as soon as every item is decided", async () => {
  const { spark, result } = run([[setPrice(1, 650, "tin", "Peak milk na 650"), setPrice(2, 100, "sachet", "the sachet na 100"), flag(3, "How much is one pack of Indomie?")]]);
  const r = await result;
  expect(r.stopped).toBe("all-done");
  expect(r.lines).toEqual([
    { item: 1, name: "Peak milk tin", price: { naira: 650, unit: "tin", quote: "Peak milk na 650" }, question: null },
    { item: 2, name: "Milo sachet", price: { naira: 100, unit: "sachet", quote: "the sachet na 100" }, question: null },
    { item: 3, name: "Indomie pack", price: null, question: "How much is one pack of Indomie?" },
  ]);
  expect(spark.calls).toHaveLength(1);
  expect(guard.callsForJob("job1")).toBe(1);
});

describe("never guesses", () => {
  test("a quote the trader never said is refused, and Spark is told why", async () => {
    const { spark, result } = run([[setPrice(3, 250, "pack", "Indomie na 250")], [flag(3, "How much is Indomie?")], "done"]);
    const r = await result;
    expect(r.events[0]).toMatchObject({ accepted: false, reason: "quote must be the trader's exact words from the transcript" });
    const turn2 = (spark.calls[1]!.body as { input: { type: string; output?: string }[] }).input;
    expect(turn2.find((i) => i.type === "function_call_output")!.output).toContain("exact words");
    expect(r.lines[2]).toMatchObject({ price: null, question: "How much is Indomie?" });
  });

  test("a price that doesn't match the number in a real quote is refused", async () => {
    const r = await run([[setPrice(1, 750, "tin", "Peak milk na 650")], "done"]).result;
    expect(r.events[0]).toMatchObject({ accepted: false });
    expect(r.lines[0]!.price).toBeNull();
    expect(r.lines[0]!.question).toBe("How much is Peak milk tin?");
  });

  test("an item Spark never decides is asked about, never left blank or guessed", async () => {
    const r = await run(["I priced what I could."]).result;
    expect(r.stopped).toBe("model-finished");
    expect(r.lines.every((l) => l.price === null && l.question === `How much is ${l.name}?`)).toBe(true);
  });
});

test("a later correction wins over an earlier price", async () => {
  const r = await run([[setPrice(2, 1000, "strip", "Milo strip na 1,000")], [setPrice(2, 100, "sachet", "the sachet na 100")], "done"]).result;
  expect(r.lines[1]!.price).toEqual({ naira: 100, unit: "sachet", quote: "the sachet na 100" });
});

test("history is replayed statelessly with encrypted reasoning and matching call ids", async () => {
  const { spark, result } = run([[setPrice(1, 650, "tin", "Peak milk na 650")], "done"]);
  await result;
  const first = spark.calls[0]!.body as Record<string, any>;
  expect(first).toMatchObject({ model: "muse-spark-1.3", store: false, include: ["reasoning.encrypted_content"], max_output_tokens: 16000 });
  expect(first.tool_choice).toBeUndefined();
  expect(first.temperature).toBeUndefined();
  expect(first.input[0].role).toBe("developer");
  expect(first.tools.every((t: { strict: boolean }) => t.strict)).toBe(true);
  const second = (spark.calls[1]!.body as { input: Record<string, unknown>[] }).input;
  expect(second.find((i) => i.type === "reasoning")).toMatchObject({ encrypted_content: "enc-1" });
  expect(second.find((i) => i.type === "function_call_output")).toMatchObject({ call_id: "call_1_0", output: '{"ok":true}' });
});

test(`stops after ${MAX_TURNS} turns`, async () => {
  const turns = Array.from({ length: MAX_TURNS }, (_, i) => [setPrice(1, 650 + i, "tin", "Peak milk na 650")]);
  const { spark, result } = run(turns);
  const r = await result;
  expect(r.stopped).toBe("turn-cap");
  expect(spark.calls).toHaveLength(MAX_TURNS);
});

test("stops when the same call is made 3 times", async () => {
  const same = [setPrice(3, 250, "pack", "Indomie na 250")];
  const { spark, result } = run([same, same, same, same]);
  expect((await result).stopped).toBe("repeat-cap");
  expect(spark.calls).toHaveLength(3);
});

test("an incomplete response throws, never a partial list", async () => {
  const spark = scriptedSpark([]);
  const client = new MetaClient({ apiKey: "k", guard, fetch: (async () => new Response(JSON.stringify({ status: "incomplete", output: [] }))) as unknown as typeof fetch });
  await expect(priceItems(client, "j", items, said)).rejects.toBeInstanceOf(SparkError);
  expect(spark.calls).toHaveLength(0);
});

test("no items means no paid call", async () => {
  const spark = scriptedSpark([]);
  const r = await priceItems(new MetaClient({ apiKey: "k", guard, fetch: spark.fetch }), "j", [], said);
  expect(r.lines).toEqual([]);
  expect(spark.calls).toHaveLength(0);
});
