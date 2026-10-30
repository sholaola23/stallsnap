import { describe, expect, test } from "bun:test";
import { toWav, transcribeNote, VoiceError } from "./transcribe.ts";
import { testClient } from "../test/fakes.ts";

// One second of a 440 Hz tone as Ogg Opus, made with ffmpeg: the format WhatsApp voice notes use.
async function oggTone(seconds = 1): Promise<Buffer> {
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "libopus", "-f", "ogg", "pipe:1"],
    { stdout: "pipe" },
  );
  return Buffer.from(await new Response(proc.stdout).arrayBuffer());
}

const json = (body: unknown) => JSON.stringify(body);

describe("voice note to text", () => {
  test("an Ogg Opus note becomes 24 kHz mono 16-bit WAV", async () => {
    const wav = await toWav(await oggTone());
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
  });

  test("something that isn't audio gets a plain message", async () => {
    await expect(toWav(Buffer.from("not audio"))).rejects.toBeInstanceOf(VoiceError);
  });

  test("sends the WAV with English bias and the photo's product names, and bills whole seconds", async () => {
    const { client, calls, budget } = testClient({
      "muse-voice-transcribe-1.0": json({ transcript: " Peak milk na 1,500. ", audioDurationMs: 30_900 }),
    });
    const text = await transcribeNote(client, await oggTone(), ["Peak milk tin", "Peak milk tin", " ", "Indomie carton"]);
    expect(text).toBe("Peak milk na 1,500.");
    expect(calls[0]!.body).toMatchObject({
      model: "muse-voice-transcribe-1.0",
      mode: "ENDPOINTING",
      audioEncoding: "WAV",
      languageBias: ["English"],
      keywords: ["Peak milk tin", "Indomie carton"],
    });
    expect(calls[0]!.body.audioBytes as number).toBeGreaterThan(44);
    expect(budget.runSpendUsd).toBeCloseTo((30 * 0.18) / 3600, 8);
  });

  test("the same note again is free", async () => {
    const { client, calls } = testClient({ "muse-voice-transcribe-1.0": json({ transcript: "hello", audioDurationMs: 1000 }) });
    const ogg = await oggTone();
    await transcribeNote(client, ogg);
    await transcribeNote(client, ogg);
    expect(calls).toHaveLength(1);
  });

  test("a silent or empty transcript asks the trader to record again", async () => {
    const { client } = testClient({ "muse-voice-transcribe-1.0": json({ transcript: "   ", audioDurationMs: 1000 }) });
    await expect(transcribeNote(client, await oggTone())).rejects.toThrow("couldn't hear any words");
  });

  test("an API error is not billed", async () => {
    const { client, budget } = testClient({ "muse-voice-transcribe-1.0": 429 });
    await expect(transcribeNote(client, await oggTone())).rejects.toThrow("429");
    expect(budget.spentToday()).toBe(0);
  });
});
