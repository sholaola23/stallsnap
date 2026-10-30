// Reading WhatsApp webhook calls: the signature check and the message shapes StallSnap uses.
import { createHmac, timingSafeEqual } from "node:crypto";

// Meta signs each call with the app secret: X-Hub-Signature-256: sha256=<hex HMAC of the raw body>.
export function validSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type Incoming =
  | { kind: "image"; id: string; from: string; mediaId: string }
  | { kind: "audio"; id: string; from: string; mediaId: string }
  | { kind: "text"; id: string; from: string; text: string }
  | { kind: "other"; id: string; from: string };

interface RawMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string };
  audio?: { id?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string } };
}

// Pulls the messages out of a webhook body. Status updates (sent, delivered, read) are ignored.
export function incomingMessages(body: unknown): Incoming[] {
  const out: Incoming[] = [];
  const entries = (body as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const m of messages as RawMessage[]) {
        if (typeof m?.id !== "string" || typeof m.from !== "string") continue;
        const base = { id: m.id, from: m.from };
        if (m.type === "image" && m.image?.id) out.push({ ...base, kind: "image", mediaId: m.image.id });
        else if (m.type === "audio" && m.audio?.id) out.push({ ...base, kind: "audio", mediaId: m.audio.id });
        else if (m.type === "text" && typeof m.text?.body === "string") out.push({ ...base, kind: "text", text: m.text.body });
        else if (m.type === "button" && m.button?.text) out.push({ ...base, kind: "text", text: m.button.text });
        else if (m.type === "interactive" && m.interactive?.button_reply?.title) out.push({ ...base, kind: "text", text: m.interactive.button_reply.title });
        else out.push({ ...base, kind: "other" });
      }
    }
  }
  return out;
}
