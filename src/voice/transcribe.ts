// The trader's voice note to text. WhatsApp voice notes are Ogg Opus; Muse Voice Transcribe
// takes mono 16-bit PCM WAV, so ffmpeg converts first (https://dev.meta.ai/docs/speech-to-text#quickstart-file).
import type { MetaClient } from "../meta/client.ts";

export const VOICE_MODEL = "muse-voice-transcribe-1.0";
const MAX_SECONDS = 600; // the endpoint's limit is 10 minutes

export class VoiceError extends Error {}

export async function toWav(audio: Buffer): Promise<Buffer> {
  const ffmpeg = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-t", String(MAX_SECONDS), "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-f", "wav", "pipe:1"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  ffmpeg.stdin.write(audio);
  await ffmpeg.stdin.end();
  const [wav, err, code] = await Promise.all([
    new Response(ffmpeg.stdout).arrayBuffer(),
    new Response(ffmpeg.stderr).text(),
    ffmpeg.exited,
  ]);
  // A WAV header alone is 44 bytes; anything that small has no sound in it.
  if (code !== 0 || wav.byteLength <= 44) {
    throw new VoiceError(`I couldn't play that voice note. Please record it again.${err ? ` (${err.trim().split("\n")[0]})` : ""}`);
  }
  return Buffer.from(wav);
}

// Product names from the photo bias recognition towards the words the trader is likely to say.
export async function transcribeNote(client: MetaClient, audio: Buffer, productNames: readonly string[] = []): Promise<string> {
  const wav = await toWav(audio);
  const keywords = [...new Set(productNames.map((n) => n.trim()).filter(Boolean))].slice(0, 50);
  const result = await client.transcribe(wav, {
    mode: "ENDPOINTING",
    model: VOICE_MODEL,
    // Nigerian Pidgin is not one of the 25 supported languages; it is English-based, so bias to English.
    languageBias: ["English"],
    ...(keywords.length ? { keywords } : {}),
  });
  const transcript = (result.transcript ?? "").trim();
  if (!transcript) throw new VoiceError("I couldn't hear any words in that voice note. Please record it again, close to the phone.");
  return transcript;
}
