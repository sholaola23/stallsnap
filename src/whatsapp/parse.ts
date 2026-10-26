// Turns a WhatsApp Cloud API webhook body into the messages StallSnap reads.
// Status receipts and other fields are dropped. Anything malformed is
// skipped, never thrown, so one odd entry can't block the rest of a batch.

export type Inbound = {
  id: string; // wamid
  from: string; // international number, digits only
  timestamp: number; // seconds
  phoneNumberId: string | undefined; // our business number it was sent to
} & (
  | { kind: "image"; mediaId: string; mimeType: string; caption?: string }
  | { kind: "voice"; mediaId: string; mimeType: string }
  | { kind: "audio"; mediaId: string; mimeType: string }
  | { kind: "text"; text: string }
  | { kind: "button"; replyId: string; title: string }
  | { kind: "other"; type: string }
);

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function media(m: Record<string, unknown>, field: string): { mediaId: string; mimeType: string } | undefined {
  const o = obj(m[field]);
  const mediaId = str(o?.id);
  if (!mediaId) return undefined;
  return { mediaId, mimeType: str(o?.mime_type) ?? "" };
}

function one(m: Record<string, unknown>, phoneNumberId: string | undefined): Inbound | undefined {
  const id = str(m.id);
  const from = str(m.from);
  const type = str(m.type);
  const timestamp = Number(str(m.timestamp) ?? m.timestamp);
  if (!id || !from || !/^\d{8,15}$/.test(from) || !type || !Number.isFinite(timestamp)) return undefined;
  const base = { id, from, timestamp, phoneNumberId };

  switch (type) {
    case "image": {
      const md = media(m, "image");
      if (!md) return undefined;
      const caption = str(obj(m.image)?.caption);
      return caption ? { ...base, kind: "image", ...md, caption } : { ...base, kind: "image", ...md };
    }
    case "voice": {
      const md = media(m, "voice") ?? media(m, "audio");
      return md ? { ...base, kind: "voice", ...md } : undefined;
    }
    case "audio": {
      const md = media(m, "audio");
      if (!md) return undefined;
      return obj(m.audio)?.voice === true ? { ...base, kind: "voice", ...md } : { ...base, kind: "audio", ...md };
    }
    case "text": {
      const text = str(obj(m.text)?.body);
      return text ? { ...base, kind: "text", text } : undefined;
    }
    case "interactive": {
      const reply = obj(obj(m.interactive)?.button_reply);
      const replyId = str(reply?.id);
      return replyId ? { ...base, kind: "button", replyId, title: str(reply?.title) ?? "" } : undefined;
    }
    default:
      return { ...base, kind: "other", type };
  }
}

export function parseWebhook(body: unknown): Inbound[] {
  const root = obj(body);
  if (root?.object !== "whatsapp_business_account") return [];
  const out: Inbound[] = [];
  for (const entry of arr(root.entry)) {
    for (const change of arr(obj(entry)?.changes)) {
      const c = obj(change);
      if (c?.field !== "messages") continue;
      const value = obj(c.value);
      const phoneNumberId = str(obj(value?.metadata)?.phone_number_id);
      for (const m of arr(value?.messages)) {
        const o = obj(m);
        const parsed = o && one(o, phoneNumberId);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
