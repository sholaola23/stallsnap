// Sending and downloading through the WhatsApp Cloud API (Graph API v26.0).
// Payloads follow Meta's references (read 26 Oct 2026): text messages,
// interactive reply buttons, interactive CTA URL buttons, typing indicators
// and media (developers.facebook.com/documentation/business-messaging/whatsapp).
//
// - One message per 6 seconds to the same person (WhatsApp's pair rate limit).
// - Rate limits, Meta server errors and network failures are retried after
//   1, 4 and 16 seconds. Other errors throw a GraphError; the token never
//   appears in an error or a log.
// - Media URLs last 5 minutes: a 404 on download fetches a fresh URL once.
import { createHash } from "node:crypto";

export const GRAPH_VERSION = "v26.0";
export const PAIR_GAP_MS = 6000;
const RETRY_DELAYS_MS = [1000, 4000, 16000];
const RETRY_CODES = new Set([131056, 130429, 80007, 4, 80008]);

export const LIMITS = { text: 4096, body: 1024, buttonTitle: 20, buttonId: 256 } as const;

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export class MediaError extends Error {
  constructor(
    readonly reason: "too-big" | "wrong-type" | "corrupt" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

export type GraphOptions = {
  token: string;
  phoneNumberId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class GraphClient {
  readonly #token: string;
  readonly #phoneNumberId: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #nextSendAt = new Map<string, number>();
  readonly #queue = new Map<string, Promise<unknown>>();

  constructor(o: GraphOptions) {
    this.#token = o.token;
    this.#phoneNumberId = o.phoneNumberId;
    this.#fetch = o.fetch ?? globalThis.fetch;
    this.#sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
    this.#now = o.now ?? Date.now;
  }

  sendText(to: string, body: string): Promise<string> {
    return this.#send(to, { type: "text", text: { preview_url: false, body: clip(body, LIMITS.text) } });
  }

  /** A message with one reply button. Body over 1024 characters is refused: send the text first. */
  sendButton(to: string, body: string, button: { id: string; title: string }): Promise<string> {
    if (body.length > LIMITS.body) throw new RangeError(`Button body is ${body.length} characters; the limit is ${LIMITS.body}`);
    return this.#send(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: [{ type: "reply", reply: { id: clip(button.id, LIMITS.buttonId), title: clip(button.title, LIMITS.buttonTitle) } }] },
      },
    });
  }

  /** A message with one button that opens a link. */
  sendLink(to: string, body: string, displayText: string, url: string): Promise<string> {
    return this.#send(to, {
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: clip(body, LIMITS.body) },
        action: { name: "cta_url", parameters: { display_text: clip(displayText, LIMITS.buttonTitle), url } },
      },
    });
  }

  /** Marks the trader's message read and shows "typing..." for up to 25 seconds. Failures are ignored. */
  async typing(messageId: string): Promise<void> {
    try {
      await this.#post(`${this.#phoneNumberId}/messages`, { messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } });
    } catch {
      // Cosmetic only.
    }
  }

  /** Downloads a photo or voice note by media id, checking its type, size and hash. */
  async download(mediaId: string, accept: { mimeTypes: readonly string[]; maxBytes: number }): Promise<{ bytes: Uint8Array; mimeType: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const info = (await this.#request("GET", `${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(this.#phoneNumberId)}`)) as Record<string, unknown>;
      const mimeType = String(info.mime_type ?? "").toLowerCase();
      const base = mimeType.split(";")[0]!.trim();
      if (!accept.mimeTypes.some((m) => m === base || m === mimeType.replace(/\s+/g, ""))) throw new MediaError("wrong-type", `Media type ${mimeType || "unknown"} isn't accepted`);
      const declared = Number(info.file_size);
      if (Number.isFinite(declared) && declared > accept.maxBytes) throw new MediaError("too-big", `Media is ${declared} bytes; the limit is ${accept.maxBytes}`);
      if (typeof info.url !== "string" || !info.url.startsWith("https://")) throw new MediaError("unavailable", "Meta gave no download URL");

      const res = await this.#fetch(info.url, { headers: { authorization: `Bearer ${this.#token}` } });
      if (res.status === 404 && attempt === 0) continue; // URL expired: ask for a fresh one
      if (!res.ok) throw new MediaError("unavailable", `Media download failed with HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > accept.maxBytes) throw new MediaError("too-big", `Media is ${bytes.byteLength} bytes; the limit is ${accept.maxBytes}`);
      if (typeof info.sha256 === "string" && info.sha256 !== "" && !hashMatches(bytes, info.sha256)) throw new MediaError("corrupt", "Media hash doesn't match");
      return { bytes, mimeType: base };
    }
    throw new MediaError("unavailable", "Media URL expired twice");
  }

  /** Sends in order per recipient, at most one message per 6 seconds each. Returns the wamid. */
  #send(to: string, message: Record<string, unknown>): Promise<string> {
    const prev = this.#queue.get(to) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const wait = (this.#nextSendAt.get(to) ?? 0) - this.#now();
        if (wait > 0) await this.#sleep(wait);
        try {
          const res = (await this.#post(`${this.#phoneNumberId}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to, ...message })) as { messages?: { id?: string }[] };
          return res.messages?.[0]?.id ?? "";
        } finally {
          this.#nextSendAt.set(to, this.#now() + PAIR_GAP_MS);
        }
      });
    this.#queue.set(to, next);
    return next;
  }

  #post(path: string, body: unknown): Promise<unknown> {
    return this.#request("POST", path, body);
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let failure: string;
      try {
        res = await this.#fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
          method,
          headers: { authorization: `Bearer ${this.#token}`, ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await res.text();
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // keep {}
        }
        if (res.ok) return json;
        const err = (json.error ?? {}) as { code?: unknown; message?: unknown };
        const code = typeof err.code === "number" ? err.code : undefined;
        failure = `WhatsApp API ${res.status}${code ? ` (code ${code})` : ""}: ${String(err.message ?? text).slice(0, 300)}`;
        const retryable = res.status >= 500 || res.status === 429 || (code !== undefined && RETRY_CODES.has(code));
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw new GraphError(res.status, code, failure);
      } catch (e) {
        if (e instanceof GraphError) throw e;
        failure = `WhatsApp API network error: ${e instanceof Error ? e.message : String(e)}`;
        if (attempt >= RETRY_DELAYS_MS.length) throw new GraphError(0, undefined, failure);
      }
      await this.#sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function hashMatches(bytes: Uint8Array, expected: string): boolean {
  const digest = createHash("sha256").update(bytes).digest();
  return expected.toLowerCase() === digest.toString("hex") || expected === digest.toString("base64");
}
