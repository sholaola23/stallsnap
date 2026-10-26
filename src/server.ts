// Starts the StallSnap server: `bun src/server.ts`.
//
// Needs APP_SECRET, WHATSAPP_VERIFY_TOKEN and ALLOWED_NUMBERS to start. To
// reply to traders it also needs MODEL_API_KEY, WHATSAPP_ACCESS_TOKEN,
// WHATSAPP_PHONE_NUMBER_ID and PUBLIC_BASE_URL; without them it still answers
// Meta's handshake and serves catalogues, and logs which settings are missing
// instead of replying. It never makes up a reply.
import { serveCatalogue, publishCatalogue } from "./catalogue/publish.ts";
import { missingEnv, readEnv } from "./env.ts";
import { JobLog } from "./joblog.ts";
import { MetaClient } from "./meta/client.ts";
import { realModels } from "./pipeline/models.ts";
import { DEFAULT_LEDGER_PATH, SpendGuard } from "./spend-guard.ts";
import { loadWebhookConfig } from "./whatsapp/config.ts";
import { Conversation } from "./whatsapp/conversation.ts";
import { GraphClient } from "./whatsapp/graph.ts";
import type { Handler } from "./whatsapp/webhook.ts";
import { createWebhook } from "./whatsapp/webhook.ts";
import { SessionStore } from "./whatsapp/sessions.ts";

const DATA_DIR = ".data";
const config = loadWebhookConfig();
const log = new JobLog(`${DATA_DIR}/joblog.jsonl`);
const guard = new SpendGuard({ ledgerPath: DEFAULT_LEDGER_PATH });

const missing = missingEnv(["MODEL_API_KEY", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "PUBLIC_BASE_URL"]);
const baseUrl = readEnv("PUBLIC_BASE_URL");
if (baseUrl && !/^https:\/\/[^\s/]+/.test(baseUrl)) throw new Error("PUBLIC_BASE_URL must start with https://");

let handle: Handler;
if (missing.length === 0) {
  const conversation = new Conversation({
    store: new SessionStore(`${DATA_DIR}/sessions.json`),
    log,
    messenger: new GraphClient({ token: readEnv("WHATSAPP_ACCESS_TOKEN")!, phoneNumberId: readEnv("WHATSAPP_PHONE_NUMBER_ID")! }),
    models: realModels(new MetaClient({ apiKey: readEnv("MODEL_API_KEY")!, guard })),
    publish: (s) => publishCatalogue(s, DATA_DIR, baseUrl!),
    dataDir: DATA_DIR,
  });
  handle = (msg) => conversation.handle(msg);
} else {
  console.warn(`Not replying to traders until these are set: ${missing.join(", ")}`);
  handle = async (msg) => console.log(`Received ${msg.kind} ${msg.id} from ...${msg.from.slice(-4)}; not replying (settings missing)`);
}

const webhook = createWebhook({ config, log, handle });
webhook.recover();

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  fetch: (req) => (req.method === "GET" && serveCatalogue(new URL(req.url).pathname, DATA_DIR)) || webhook.fetch(req),
});
console.log(`StallSnap listening on port ${server.port}`);
