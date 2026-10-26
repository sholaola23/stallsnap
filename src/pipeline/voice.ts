// Voice note to text with Muse Voice Transcribe.
//
// The endpoint takes mono 16-bit PCM WAV at 16 or 24 kHz, up to 10 minutes
// (https://dev.meta.ai/docs/speech-to-text). WhatsApp voice notes are
// OGG/Opus, so each note is converted with ffmpeg first.
//
// Nigerian Pidgin is not one of the model's evaluated languages, so the
// request biases towards English and passes price words and item names as
// keywords. The rough transcript is cleaned up later by Muse Spark.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetaClient } from "../meta/client.ts";
import { VOICE_MODEL, voiceUsd } from "../meta/costs.ts";

export const MAX_VOICE_MS = 10 * 60 * 1000;
export const PRICE_KEYWORDS = ["naira", "₦", "kobo", "thousand", "hundred"];
const MAX_KEYWORDS = 40;

export class VoiceNoteError extends Error {
  constructor(
    readonly reason: "unreadable" | "empty" | "too-long",
    message: string,
  ) {
    super(message);
    this.name = "VoiceNoteError";
  }
}

export type Wav = { bytes: Uint8Array; durationMs: number };

/** Converts any audio ffmpeg can read to mono 16-bit 24 kHz WAV. */
export async function toWav(audio: Uint8Array): Promise<Wav> {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, "out.wav");
    writeFileSync(input, audio);
    const proc = Bun.spawn(
      ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", input, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-f", "wav", output],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      throw new VoiceNoteError("unreadable", "That voice note couldn't be read");
    }
    const bytes = new Uint8Array(readFileSync(output));
    return { bytes, durationMs: wavDurationMs(bytes) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Duration of a PCM WAV from its header, or throws if it isn't one. */
export function wavDurationMs(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new VoiceNoteError("unreadable", "Not a WAV file");
  }
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt " && at + 16 <= bytes.byteLength) byteRate = view.getUint32(at + 16, true);
    if (tag(at) === "data") {
      if (byteRate === 0) break;
      const dataBytes = Math.min(size, bytes.byteLength - at - 8);
      return Math.floor((dataBytes * 1000) / byteRate);
    }
    at += 8 + size + (size % 2);
  }
  throw new VoiceNoteError("unreadable", "WAV file has no audio");
}

/** Keywords for the transcriber: price words, then item names, deduplicated. */
export function voiceKeywords(itemNames: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...PRICE_KEYWORDS, ...itemNames]) {
    const k = raw.replace(/\s+/g, " ").trim().slice(0, 40);
    if (k === "" || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

/** Transcribes one voice note. An empty transcript throws so the trader can be asked again. */
export async function transcribe(
  client: MetaClient,
  jobId: string,
  wav: Wav,
  itemNames: readonly string[],
): Promise<string> {
  if (wav.durationMs < 300) throw new VoiceNoteError("empty", "The voice note is empty");
  if (wav.durationMs > MAX_VOICE_MS) throw new VoiceNoteError("too-long", "The voice note is longer than 10 minutes");
  const request = {
    model: VOICE_MODEL,
    audioEncoding: "WAV",
    mode: "PUSH_TO_TALK",
    languageBias: ["English"],
    keywords: voiceKeywords(itemNames),
  };
  const res = (await client.transcribe(
    { jobId, what: "voice transcribe", maxUsd: voiceUsd(wav.durationMs + 1000) },
    request,
    wav.bytes,
    (r) => voiceUsd(Number((r as { audioDurationMs?: unknown }).audioDurationMs)),
  )) as { transcript?: unknown };
  const text = typeof res.transcript === "string" ? res.transcript.trim() : "";
  if (text === "") throw new VoiceNoteError("empty", "No speech was heard in the voice note");
  return text;
}
