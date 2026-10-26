// Messy-input suite: voice notes and transcribe responses.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaClient } from "../../src/meta/client.ts";
import { fakeMeta } from "../../src/meta/test-fakes.ts";
import { VoiceNoteError, toWav, transcribe, wavDurationMs } from "../../src/pipeline/voice.ts";
import { SpendGuard } from "../../src/spend-guard.ts";

let dir: string;
let guard: SpendGuard;
const clip = async (args: string[]) => {
  const tmp = mkdtempSync(join(tmpdir(), "clip-"));
  const out = join(tmp, "clip.ogg");
  const p = Bun.spawn(["ffmpeg", "-nostdin", "-loglevel", "error", ...args, out]);
  if ((await p.exited) !== 0) throw new Error("ffmpeg failed");
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(tmp, { recursive: true, force: true });
  return bytes;
};
let stereo: Uint8Array;
let silent: Uint8Array;

beforeAll(async () => {
  stereo = await clip(["-f", "lavfi", "-i", "sine=f=300:d=1.5", "-f", "lavfi", "-i", "sine=f=500:d=1.5", "-filter_complex", "amerge=inputs=2", "-c:a", "libopus", "-ar", "48000"]);
  silent = await clip(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.1", "-c:a", "libopus"]);
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "voice-messy-"));
  guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("audio that isn't a clean voice note", () => {
  test("stereo is mixed down to mono", async () => {
    const wav = await toWav(stereo);
    expect(new DataView(wav.bytes.buffer, wav.bytes.byteOffset).getUint16(22, true)).toBe(1);
  });

  test("an empty file is refused", async () => {
    await expect(toWav(new Uint8Array())).rejects.toBeInstanceOf(VoiceNoteError);
  });

  test("a note cut off half way still converts what arrived, or is refused cleanly", async () => {
    const half = stereo.subarray(0, Math.floor(stereo.length / 2));
    const result = await toWav(half).then(
      (w) => w.durationMs,
      (e) => (e instanceof VoiceNoteError ? -1 : Number.NaN),
    );
    expect(result).not.toBeNaN();
  });

  test("a near-silent 0.1 s tap is refused before any paid call", async () => {
    const meta = fakeMeta(() => ({}));
    const client = new MetaClient({ apiKey: "k", guard, fetch: meta.fetch });
    await expect(transcribe(client, "j", await toWav(silent), [])).rejects.toMatchObject({ reason: "empty" });
    expect(meta.calls).toHaveLength(0);
  });

  test("a WAV whose header claims more data than the file holds is timed by what is there", () => {
    const b = new Uint8Array(44 + 4800);
    const v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WAVEfmt "), 8);
    v.setUint32(16, 16, true);
    v.setUint32(28, 48_000, true);
    b.set(new TextEncoder().encode("data"), 36);
    v.setUint32(40, 0xffffffff, true);
    expect(wavDurationMs(b)).toBe(100);
  });

  for (const [name, bytes] of [
    ["not RIFF", new TextEncoder().encode("RIFX....WAVE")],
    ["too short", new Uint8Array(8)],
    ["no data chunk", new TextEncoder().encode("RIFF\0\0\0\0WAVE")],
  ] as const) {
    test(`header: ${name}`, () => expect(() => wavDurationMs(bytes)).toThrow(VoiceNoteError));
  }
});

describe("transcribe responses that aren't what we expect", () => {
  for (const [name, body] of [
    ["no transcript field", { sessionId: "s", audioDurationMs: 1000 }],
    ["transcript is null", { transcript: null, audioDurationMs: 1000 }],
    ["transcript is a number", { transcript: 42, audioDurationMs: 1000 }],
  ] as const) {
    test(`${name} means no speech, never invented text`, async () => {
      const client = new MetaClient({ apiKey: "k", guard, fetch: fakeMeta(() => body).fetch });
      await expect(transcribe(client, "j", await toWav(stereo), [])).rejects.toMatchObject({ reason: "empty" });
    });
  }

  test("a missing duration is charged the worst case, not zero", async () => {
    const client = new MetaClient({ apiKey: "k", guard, fetch: fakeMeta(() => ({ transcript: "Rice na 6k" })).fetch });
    const wav = await toWav(stereo);
    await transcribe(client, "j", wav, []);
    expect(guard.spentToday()).toBeGreaterThan(0);
  });

  test("Pidgin and the naira sign come back as sent", async () => {
    const client = new MetaClient({ apiKey: "k", guard, fetch: fakeMeta(() => ({ transcript: " Peak milk na ₦1,800, Milo na 3k ", audioDurationMs: 1500 })).fetch });
    expect(await transcribe(client, "j", await toWav(stereo), [])).toBe("Peak milk na ₦1,800, Milo na 3k");
  });
});
