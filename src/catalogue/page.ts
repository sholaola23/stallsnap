// The public catalogue page a trader shares: one card per product, from their own photo.
// Plain HTML and CSS, no scripts, so it loads fast on a cheap phone on mobile data.
import type { Catalogue } from "./store.ts";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString("en-GB")}`;
}

function dateText(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
}

export function cataloguePage(catalogue: Catalogue): string {
  const name = escapeHtml(catalogue.stallName);
  const cards = catalogue.items
    .map((item, i) => {
      const price =
        item.amount === null
          ? `<p class="price ask">Ask for price</p>`
          : `<p class="price">${formatNaira(item.amount)}${item.unit ? ` <span class="unit">${escapeHtml(item.unit)}</span>` : ""}</p>`;
      // The first row of pictures loads straight away; the rest wait until they are scrolled to.
      const loading = i < 2 ? `fetchpriority="high"` : `loading="lazy"`;
      return `<li class="card">
  <img src="${catalogue.slug}/${item.image}" width="600" height="600" alt="${escapeHtml(item.name)}" ${loading}>
  <h2>${escapeHtml(item.name)}</h2>
  ${price}
</li>`;
    })
    .join("\n");
  const count = catalogue.items.length;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}: price list</title>
<meta name="description" content="${count} ${count === 1 ? "item" : "items"} with prices from ${name}.">
<style>
:root { --bg: #faf7f2; --card: #ffffff; --text: #1c1917; --muted: #57534e; --accent: #0f6b3a; --line: #e7e1d8; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #171412; --card: #24201d; --text: #f5f1ea; --muted: #c4bcb1; --accent: #6fd39b; --line: #3a342f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main, footer { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 24px; }
h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 4px; overflow-wrap: anywhere; }
.meta { color: var(--muted); margin: 0 0 20px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
@media (min-width: 700px) { ul { gap: 16px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); } }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
.card img { display: block; width: 100%; height: auto; aspect-ratio: 1; background: #fff; }
.card h2 { font-size: 1rem; font-weight: 600; margin: 10px 12px 2px; overflow-wrap: anywhere; }
.price { margin: 0 12px 12px; font-size: 1.125rem; font-weight: 700; color: var(--accent); }
.unit { font-size: 0.875rem; font-weight: 400; color: var(--muted); }
.ask { color: var(--muted); font-weight: 600; }
.empty { color: var(--muted); }
footer { color: var(--muted); font-size: 0.875rem; padding-top: 24px; padding-bottom: 32px; }
</style>
</head>
<body>
<header>
<h1>${name}</h1>
<p class="meta">${count} ${count === 1 ? "item" : "items"} · Prices updated ${dateText(catalogue.publishedAt)}</p>
</header>
<main>
${count ? `<ul>\n${cards}\n</ul>` : `<p class="empty">No items yet.</p>`}
</main>
<footer>
<p>Pictures are from the trader's own stall photo. Made with StallSnap.</p>
</footer>
</body>
</html>`;
}

export function notFoundPage(): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Price list not found</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 16px"><h1>Price list not found</h1><p>This link may be mistyped. Ask the trader to send it again.</p></body></html>`;
}
