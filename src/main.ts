// Starts the server from environment settings. Names match docs/whatsapp-setup.md.
// Without the WhatsApp settings the server still serves catalogue pages, with no webhook.
import { join } from "node:path";
import { CatalogueStore } from "./catalogue/store.ts";
import { MetaClient } from "./meta/client.ts";
import { Budget, budgetFromEnv } from "./meta/spend.ts";
import { handler, type WebhookSettings } from "./server.ts";
import { Bot } from "./whatsapp/bot.ts";
import { GraphClient } from "./whatsapp/graph.ts";

const WHATSAPP_SETTINGS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "ALLOWED_NUMBERS", "PUBLIC_URL"] as const;

export function parseAllowedNumbers(raw: string): Set<string> {
  // WhatsApp sends numbers as digits only, with the country code: "447700900123".
  const numbers = raw
    .split(",")
    .map((n) => n.replace(/[\s+()-]/g, ""))
    .filter(Boolean);
  for (const n of numbers) if (!/^\d{8,15}$/.test(n)) throw new Error("ALLOWED_NUMBERS must be phone numbers with country codes, separated by commas");
  return new Set(numbers);
}

export function restyleSetting(raw: string | undefined): boolean {
  const value = raw ?? "1";
  if (value !== "0" && value !== "1") throw new Error(`STALLSNAP_RESTYLE must be 0 or 1, got "${value}"`);
  return value === "1";
}

export async function startFromEnv(env: Record<string, string | undefined> = process.env): Promise<void> {
  const dataDir = env.STALLSNAP_DATA_DIR ?? "data";
  const store = new CatalogueStore(join(dataDir, "catalogues"));
  const present = WHATSAPP_SETTINGS.filter((name) => env[name]);
  let webhook: WebhookSettings | undefined;

  if (present.length === WHATSAPP_SETTINGS.length) {
    const budget = new Budget({ ...budgetFromEnv(env), ledgerPath: join(dataDir, "spend.jsonl") });
    const client = new MetaClient({ budget, apiKey: env.MODEL_API_KEY, cacheDir: join(dataDir, "meta-cache") });
    const bot = new Bot({
      client,
      sender: new GraphClient(env.WHATSAPP_ACCESS_TOKEN!, env.WHATSAPP_PHONE_NUMBER_ID!),
      store,
      dataDir,
      publicUrl: env.PUBLIC_URL!,
      stallName: env.CATALOGUE_STALL_NAME?.trim() || "Price list",
      allowedNumbers: parseAllowedNumbers(env.ALLOWED_NUMBERS!),
      restyle: restyleSetting(env.STALLSNAP_RESTYLE),
      log: (m) => console.log(`[bot] ${m}`),
    });
    webhook = { bot, appSecret: env.APP_SECRET!, verifyToken: env.WHATSAPP_VERIFY_TOKEN! };
  } else if (present.length > 0) {
    const missing = WHATSAPP_SETTINGS.filter((name) => !env[name]);
    throw new Error(`WhatsApp is half set up. Missing: ${missing.join(", ")}`);
  }

  const port = Number(env.PORT ?? 3000);
  Bun.serve({ port, fetch: handler(store, webhook) });
  console.log(`StallSnap listening on port ${port}${webhook ? " with the WhatsApp webhook" : " (catalogue pages only)"}`);
}
