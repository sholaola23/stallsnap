// The WhatsApp webhook endpoint.
//
// GET  /webhook  Meta's verify handshake.
// POST /webhook  Signed message batches. The signature is checked on the raw
//                body, numbers outside ALLOWED_NUMBERS are dropped with no
//                download or model call, each new message id is written to
//                the job log, and only then is 200 returned. Handling runs
//                after the reply, one message at a time, in arrival order.
import type { JobLog } from "../joblog.ts";
import type { WebhookConfig } from "./config.ts";
import type { Inbound } from "./parse.ts";
import { parseWebhook } from "./parse.ts";
import { sameSecret, signatureIsValid } from "./signature.ts";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type Handler = (msg: Inbound) => Promise<void>;

export type Webhook = {
  fetch(req: Request): Promise<Response>;
  /** Hands messages a crash left unhandled back to the handler. */
  recover(): void;
  /** Resolves once every queued message has been handled. */
  idle(): Promise<void>;
};

export function createWebhook(opts: {
  config: WebhookConfig;
  log: JobLog;
  handle: Handler;
  onError?: (msg: Inbound, error: unknown) => void;
  /** Called, never awaited, for a message to our number from someone who isn't a trader. */
  onStranger?: (msg: Inbound) => void;
}): Webhook {
  const { config, log, handle } = opts;
  const onError =
    opts.onError ?? ((msg, e) => console.error(`Handling ${msg.kind} message ${msg.id} failed:`, e instanceof Error ? e.message : e));
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (msg: Inbound) => {
    queue = queue.then(async () => {
      try {
        await handle(msg);
      } catch (e) {
        onError(msg, e);
      }
      log.handled(msg.id);
    });
  };

  function verify(url: URL): Response {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode !== "subscribe" || !sameSecret(token, config.verifyToken)) {
      return new Response("Forbidden", { status: 403 });
    }
    // Meta sends an integer. Echoing anything else would reflect input.
    if (!/^\d{1,32}$/.test(challenge)) return new Response("Bad challenge", { status: 400 });
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }

  async function receive(req: Request): Promise<Response> {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });
    if (!signatureIsValid(raw, req.headers.get("x-hub-signature-256"), config.appSecret)) {
      return new Response("Bad signature", { status: 401 });
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    for (const msg of parseWebhook(body)) {
      if (config.phoneNumberId !== undefined && msg.phoneNumberId !== config.phoneNumberId) continue;
      if (!config.allowed.has(msg.from)) {
        opts.onStranger?.(msg);
        continue;
      }
      if (log.accept(msg.id, msg)) enqueue(msg);
    }
    return new Response("OK", { status: 200 });
  }

  return {
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") return new Response("ok");
      if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });
      if (req.method === "GET") return verify(url);
      if (req.method === "POST") return receive(req);
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    },
    recover() {
      for (const { msg } of log.pending()) enqueue(msg as Inbound);
    },
    idle: () => queue,
  };
}
