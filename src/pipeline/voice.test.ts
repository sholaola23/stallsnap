import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../meta/client.ts";
import { fakeMeta } from "../meta/test-fakes.ts";
import { SpendGuard } from "../spend-guard.ts";
import { VoiceNoteError, toWav, transcribe, voiceKeywords, wavDurationMs } from "./voice.ts";

let dir: string;
let guard: SpendGuard;
let opusNote: Uint8Array;

beforeAll(async () => {
  // A 2-second Opus clip in an OGG container, like a WhatsApp voice note.
  const tmp = mkdtempSync(join(tmpdir(), "opus-"));
  const out = join(tmp, "note.ogg");
  const p = Bun.spawn(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", "-ar", "48000", out]);
  if ((await p.exited) !== 0) throw new Error("ffmpeg with libopus is needed for these tests");
  opusNote = new Uint8Array(readFileSync(out));
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "voice-test-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("toWav", () => {
  test("turns an OGG/Opus voice note into mono 16-bit 24 kHz WAV", async () => {
    const wav = await toWav(opusNote);
    const view = new DataView(wav.bytes.buffer, wav.bytes.byteOffset);
    expect(String.fromCharCode(...wav.bytes.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(24_000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(wav.durationMs).toBeGreaterThan(1900);
    expect(wav.durationMs).toBeLessThan(2100);
  });

  test("bytes that aren't audio are refused", async () => {
    await expect(toWav(new TextEncoder().encode("not audio at all"))).rejects.toBeInstanceOf(VoiceNoteError);
  });
});

describe("transcribe", () => {
  test("sends WAV with English bias and price and item keywords, and records the real cost", async () => {
    const meta = fakeMeta((c) => {
      expect(c.url).toBe("https://api.meta.ai/v1/asr/transcribe");
      return { sessionId: "s1", transcript: "Indomie na two hundred naira", audioDurationMs: 2000, turns: [] };
    });
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch });
    const text = await transcribe(client, "job1", await toWav(opusNote), ["Indomie", "Peak milk"]);
    expect(text).toBe("Indomie na two hundred naira");

    const form = meta.calls[0]!.body as FormData;
    const request = JSON.parse(await (form.get("request") as Blob).text());
    expect(request).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
      languageBias: ["English"],
      keywords: ["naira", "₦", "kobo", "thousand", "tousand", "hundred", "Indomie", "Peak milk"],
    });
    expect((form.get("audio") as Blob).type).toBe("audio/wav");
    expect(meta.calls[0]!.headers.get("accept")).toBe("application/json");
    expect(guard.spentToday()).toBeCloseTo((2 / 3600) * 0.18, 12);
  });

  test("no speech heard means the trader is asked again", async () => {
    const meta = fakeMeta(() => ({ sessionId: "s", transcript: "   ", audioDurationMs: 2000, turns: [] }));
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch });
    await expect(transcribe(client, "j", await toWav(opusNote), [])).rejects.toMatchObject({ reason: "empty" });
  });

  test("a note over 10 minutes is refused before any paid call", async () => {
    const meta = fakeMeta(() => ({}));
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch });
    await expect(transcribe(client, "j", { bytes: new Uint8Array(), durationMs: 10 * 60 * 1000 + 1 }, [])).rejects.toMatchObject({
      reason: "too-long",
    });
    expect(meta.calls).toHaveLength(0);
  });
});

test("wavDurationMs reads the header", () => {
  const header = new Uint8Array(44 + 48_000);
  const v = new DataView(header.buffer);
  header.set(new TextEncoder().encode("RIFF"), 0);
  header.set(new TextEncoder().encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint32(28, 48_000, true); // byte rate: 24 kHz mono 16-bit
  header.set(new TextEncoder().encode("data"), 36);
  v.setUint32(40, 48_000, true);
  expect(wavDurationMs(header)).toBe(1000);
});

test("voiceKeywords dedupes and caps", () => {
  expect(voiceKeywords(["Naira", "  Peak   milk ", "peak milk", ""])).toEqual(["naira", "₦", "kobo", "thousand", "tousand", "hundred", "Peak milk"]);
  expect(voiceKeywords(Array.from({ length: 100 }, (_, i) => `item ${i}`))).toHaveLength(40);
});
