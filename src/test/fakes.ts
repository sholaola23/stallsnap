// Test helpers: a synthetic stall photo and a fake Meta API that answers like the real one.
// Nothing here is a real trader's photo or a recorded API answer.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
// The encoder is internal to @meta-sam/parser (made for synthetic conformance data), so import it by path.
import { encodeSegmentationMask } from "../../node_modules/@meta-sam/parser/dist/mask-codec.js";
import { MetaClient } from "../meta/client.ts";
import { Budget, type BudgetSettings } from "../meta/spend.ts";

export const PHOTO_W = 800;
export const PHOTO_H = 600;

// White table with a red disc (left) and a blue square (right).
export async function syntheticStall(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_W}" height="${PHOTO_H}">
    <rect width="100%" height="100%" fill="#f4f0e8"/>
    <circle cx="200" cy="300" r="100" fill="#d01010"/>
    <rect x="500" y="200" width="200" height="200" fill="#1030d0"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

export function sse(events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

export function textStream(text: string, usage = { input_tokens: 1000, output_tokens: 200 }): string {
  const lane = { item_id: "msg_1", output_index: 0, content_index: 0 };
  return sse([
    { type: "response.output_text.delta", delta: text, ...lane },
    { type: "response.output_text.done", text, ...lane },
    { type: "response.completed", response: { usage } },
  ]);
}

export interface MaskSpec {
  id: number;
  left: number;
  top: number;
  right: number; // exclusive
  bottom: number; // exclusive
  fill: (x: number, y: number) => boolean; // x, y inside the box
}

export function samLine(specs: MaskSpec[], width = PHOTO_W, height = PHOTO_H): string {
  const records = specs.map((s) => {
    const w = s.right - s.left;
    const h = s.bottom - s.top;
    const raster = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raster[y * w + x] = s.fill(x, y) ? 1 : 0;
    const mask = encodeSegmentationMask(raster, w, h);
    return `${s.id}<|box;x1=${s.left};y1=${s.top};x2=${s.right - 1};y2=${s.bottom - 1};w=${width};h=${height}|><|mask;x=0;y=0;data=${h},${w},${mask.payload}|>`;
  });
  return specs.length ? `<0f>${records.join(",")}` : "";
}

export function samStream(line: string): string {
  const lane = { item_id: "msg_1", output_index: 0, content_index: 0 };
  const events: unknown[] = line ? [{ type: "response.output_text.delta", delta: line, ...lane }] : [];
  events.push({ type: "response.output_text.done", text: line, ...lane }, { type: "response.completed", response: { usage: {} } });
  return sse(events);
}

export interface FakeCall {
  model: string;
  body: Record<string, unknown>;
}

// Routes each request by model to a canned answer (or a status code) and records the calls.
// An array answer is used in order, one entry per call; the last entry repeats.
export type FakeAnswer = string | number | (string | number)[];

export function fakeFetch(answers: Record<string, FakeAnswer>): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = async (_url: string | URL | Request, init?: RequestInit) => {
    let body: Record<string, unknown>;
    if (init?.body instanceof FormData) {
      body = JSON.parse(await (init.body.get("request") as Blob).text()) as Record<string, unknown>;
      body.audioBytes = (init.body.get("audio") as Blob).size;
    } else {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    }
    const model = String(body.model);
    const count = calls.filter((c) => c.model === model).length;
    calls.push({ model, body });
    const entry = answers[model];
    const answer = Array.isArray(entry) ? entry[Math.min(count, entry.length - 1)] : entry;
    if (answer === undefined) return new Response(`no fake for ${model}`, { status: 404 });
    if (typeof answer === "number") return new Response("fake failure", { status: answer });
    return new Response(answer, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

export function testBudget(overrides: Partial<BudgetSettings> = {}): Budget {
  const dir = mkdtempSync(join(tmpdir(), "stallsnap-"));
  return new Budget({ live: true, maxCalls: 10, dailyCapUsd: 2, ledgerPath: join(dir, "spend.jsonl"), ...overrides });
}

export function testClient(answers: Record<string, FakeAnswer>, budget = testBudget()) {
  const fake = fakeFetch(answers);
  const cacheDir = mkdtempSync(join(tmpdir(), "stallsnap-cache-"));
  const client = new MetaClient({ budget, apiKey: "test-key", fetch: fake.fetch, cacheDir });
  return { client, calls: fake.calls, budget, cacheDir };
}

// A Spark turn that calls tools: each entry is [name, arguments].
export function toolStream(calls: [string, Record<string, unknown>][]): string {
  return sse([
    ...calls.map(([name, args], i) => ({
      type: "response.output_item.done",
      item: { type: "function_call", status: "completed", call_id: `call_${i}_${name}`, name, arguments: JSON.stringify(args) },
    })),
    { type: "response.completed", response: { usage: { input_tokens: 800, output_tokens: 120 } } },
  ]);
}
