// The public catalogue page: plain HTML, no JavaScript, built for a cheap
// phone on a slow connection. Every value from a trader or a model is escaped.

export const CATALOGUE_TITLE = "StallSnap Demo Stall";

export type CatalogueItem = {
  name: string;
  /** Whole naira, or null when the trader hasn't given a price. */
  naira: number | null;
  unit: string | null;
  image: string; // file name next to the page, such as "item-1.webp"
  width: number;
  height: number;
};

export type Catalogue = { title: string; items: CatalogueItem[]; updatedAt: string };

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const priceText = (i: Pick<CatalogueItem, "naira" | "unit">) =>
  i.naira === null ? "Ask for price" : `₦${i.naira.toLocaleString("en-GB")}${i.unit ? ` per ${i.unit}` : ""}`;

/**
 * `contact` is the demo stall's WhatsApp number, digits only (never a trader's own number).
 * Without it there is no "Message on WhatsApp" button.
 */
export function renderCatalogue(c: Catalogue, base: string, contact?: string): string {
  const updated = new Date(c.updatedAt);
  const date = Number.isNaN(updated.getTime()) ? "" : updated.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const cards = c.items
    .map(
      // The heading below names the item, so the picture's alt text is empty rather than read twice.
      (item, i) => `      <li class="item">
        <img src="${escape(`${base}/${item.image}`)}" alt="" width="${item.width}" height="${item.height}"${i >= 4 ? ' loading="lazy"' : ""} decoding="async">
        <h2>${escape(item.name)}</h2>
        <p class="${item.naira === null ? "price ask" : "price"}">${escape(priceText(item))}</p>
      </li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escape(c.title)}</title>
  <link rel="icon" href="data:,">
  <meta name="description" content="Prices at ${escape(c.title)}, ${c.items.length} ${c.items.length === 1 ? "item" : "items"}.">
  <style>
    :root { --bg: #fbf7f0; --card: #ffffff; --ink: #1d1a16; --muted: #5b544a; --accent: #0b6b3a; --ask: #8a4b00; --line: #e7dfd2; }
    @media (prefers-color-scheme: dark) { :root { --bg: #171512; --card: #221f1a; --ink: #f4efe6; --muted: #c9c0b2; --accent: #6fd39a; --ask: #f2b46b; --line: #3a342c; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    header, main, footer { max-width: 960px; margin: 0 auto; padding: 0 16px; }
    header { padding-top: 24px; }
    h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 4px; }
    .meta { color: var(--muted); margin: 0 0 20px; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    .item { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; }
    .item img { width: 100%; height: auto; aspect-ratio: 1 / 1; object-fit: contain; border-radius: 8px; }
    h2 { font-size: 1rem; margin: 8px 0 2px; overflow-wrap: anywhere; }
    .price { margin: 0; font-weight: 700; color: var(--accent); font-size: 1.05rem; }
    .price.ask { color: var(--ask); font-weight: 600; }
    .wa { display: inline-flex; align-items: center; min-height: 44px; padding: 10px 18px; border-radius: 999px; background: var(--accent); color: var(--card); font-weight: 700; text-decoration: none; margin: 0 0 20px; }
    .wa:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
    footer { color: var(--muted); padding-top: 24px; padding-bottom: 32px; font-size: 0.9rem; }
    @media (min-width: 640px) { h1 { font-size: 2.25rem; } ul { gap: 16px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); } }
  </style>
</head>
<body>
  <header>
    <h1>${escape(c.title)}</h1>
    <p class="meta">${c.items.length} ${c.items.length === 1 ? "item" : "items"}${date ? `. Prices from ${date}` : ""}.</p>
${contact && /^\d{8,15}$/.test(contact) ? `    <a class="wa" href="https://wa.me/${contact}">Message on WhatsApp</a>\n` : ""}  </header>
  <main>
    <ul>
${cards}
    </ul>
  </main>
  <footer>
    <p>Catalogue made with StallSnap from a photo of the stall and the trader's own prices. Pictures are the trader's real products.</p>
  </footer>
</body>
</html>
`;
}
