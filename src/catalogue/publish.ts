// Publishing: writes a confirmed list and its cut-outs to
// <dataDir>/public/<slug>/ and serves it at /c/<slug>.
//
// The slug is random, so a link never reveals the trader's number and can't
// be guessed. Only the trader's confirmed lines are published: an unpriced
// line says "Ask for price", never a number.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Session } from "../whatsapp/sessions.ts";
import { CATALOGUE_TITLE, type Catalogue, renderCatalogue } from "./page.ts";

const SLUG = /^[a-z2-7]{16}$/;
const FILE = /^item-\d{1,3}\.webp$/;
const IMAGE_SIDE = 480;

export const newSlug = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return [...randomBytes(16)].map((b) => alphabet[b & 31]).join("");
};

export async function publishCatalogue(s: Session, dataDir: string, baseUrl: string, slug = newSlug()): Promise<string> {
  if (s.lines.length === 0) throw new Error("Nothing to publish");
  for (const line of s.lines) if (!s.items.some((i) => i.item === line.item)) throw new Error(`Line ${line.item} has no cut-out`);
  const dir = join(dataDir, "public", slug);
  mkdirSync(dir, { recursive: true });

  const items: Catalogue["items"] = [];
  for (const line of s.lines) {
    const item = s.items.find((i) => i.item === line.item)!;
    const image = `item-${line.item}.webp`;
    const info = await sharp(readFileSync(item.file))
      .resize({ width: IMAGE_SIDE, height: IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80, alphaQuality: 90 })
      .toFile(join(dir, image));
    items.push({ name: line.name, naira: line.price?.naira ?? null, unit: line.price?.unit ?? null, image, width: info.width, height: info.height });
  }

  const catalogue: Catalogue = { title: CATALOGUE_TITLE, items, updatedAt: new Date().toISOString() };
  writeFileSync(join(dir, "catalogue.json.tmp"), JSON.stringify(catalogue));
  renameSync(join(dir, "catalogue.json.tmp"), join(dir, "catalogue.json"));
  return `${baseUrl.replace(/\/+$/, "")}/c/${slug}`;
}

/** Serves /robots.txt, /c/<slug> and /c/<slug>/item-N.webp. Other /c/ paths are a 404; anything else is undefined. */
export function serveCatalogue(pathname: string, dataDir: string): Response | undefined {
  if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  const m = /^\/c\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return undefined;
  const [, slug, file] = m;
  const notFound = () => new Response("Catalogue not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!slug || !SLUG.test(slug)) return notFound();
  const dir = join(dataDir, "public", slug);
  if (file !== undefined) {
    if (!FILE.test(file) || !existsSync(join(dir, file))) return notFound();
    return new Response(Bun.file(join(dir, file)), { headers: { "content-type": "image/webp", "cache-control": "public, max-age=86400" } });
  }
  if (!existsSync(join(dir, "catalogue.json"))) return notFound();
  const catalogue = JSON.parse(readFileSync(join(dir, "catalogue.json"), "utf8")) as Catalogue;
  return new Response(renderCatalogue(catalogue, `/c/${slug}`), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'self'" },
  });
}
