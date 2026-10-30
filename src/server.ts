// The web server: public catalogue pages now, the WhatsApp webhook next.
import { cataloguePage, notFoundPage } from "./catalogue/page.ts";
import { CatalogueStore } from "./catalogue/store.ts";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};

export function handler(store: CatalogueStore) {
  return (request: Request): Response => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/health") return new Response("ok");

    const page = url.pathname.match(/^\/c\/([^/]+)$/);
    if (page) {
      const catalogue = store.get(page[1]!);
      if (!catalogue) return new Response(notFoundPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
      return new Response(cataloguePage(catalogue), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ...SECURITY_HEADERS },
      });
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
    return new Response(notFoundPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const store = new CatalogueStore(process.env.STALLSNAP_DATA_DIR ? `${process.env.STALLSNAP_DATA_DIR}/catalogues` : undefined);
  Bun.serve({ port, fetch: handler(store) });
  console.log(`StallSnap listening on http://localhost:${port}`);
}
