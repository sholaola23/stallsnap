// The web server: public catalogue pages and the WhatsApp webhook.
import { cataloguePage, notFoundPage } from "./catalogue/page.ts";
import { CatalogueStore } from "./catalogue/store.ts";
import type { Bot } from "./whatsapp/bot.ts";
import { incomingMessages, validSignature } from "./whatsapp/webhook.ts";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};
const MAX_WEBHOOK_BYTES = 1024 * 1024;

export interface WebhookSettings {
  bot: Bot;
  appSecret: string;
  verifyToken: string;
}

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
}

export function handler(store: CatalogueStore, webhook?: WebhookSettings) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && webhook) {
      // Meta's one-off check when the callback URL is saved in the app dashboard.
      if (request.method === "GET") {
        const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === webhook.verifyToken;
        return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
      }
      if (request.method === "POST") {
        const raw = await request.text();
        if (raw.length > MAX_WEBHOOK_BYTES) return new Response("Too large", { status: 413 });
        if (!validSignature(raw, request.headers.get("X-Hub-Signature-256"), webhook.appSecret)) return new Response("Forbidden", { status: 403 });
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        // Answer Meta straight away; the slow work (models, replies) runs behind.
        for (const message of incomingMessages(body)) void webhook.bot.receive(message);
        return new Response("ok");
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/health") return new Response("ok");

    const page = url.pathname.match(/^\/c\/([^/]+)$/);
    if (page) {
      const catalogue = store.get(page[1]!);
      if (!catalogue) return html(notFoundPage(), 404);
      return html(cataloguePage(catalogue), 200, { "Cache-Control": "no-cache" });
    }

    const image = url.pathname.match(/^\/c\/([^/]+)\/([^/]+)$/);
    if (image) {
      const bytes = store.image(image[1]!, image[2]!);
      if (bytes) {
        return new Response(new Uint8Array(bytes), {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=300", ...SECURITY_HEADERS },
        });
      }
    }
    return html(notFoundPage(), 404);
  };
}

if (import.meta.main) {
  const { startFromEnv } = await import("./main.ts");
  await startFromEnv();
}
