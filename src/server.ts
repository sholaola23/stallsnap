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
import { cleanupStep } from "./pipeline/cleanup.ts";
import { realModels } from "./pipeline/models.ts";
import { DEFAULT_LEDGER_PATH, MAX_CALLS_PER_JOB, SpendGuard } from "./spend-guard.ts";
import { loadDemoContact, loadWebhookConfig } from "./whatsapp/config.ts";
import { Conversation } from "./whatsapp/conversation.ts";
import { GraphClient } from "./whatsapp/graph.ts";
import type { Handler } from "./whatsapp/webhook.ts";
import { MAX_BODY_BYTES, createWebhook } from "./whatsapp/webhook.ts";
import { SessionStore } from "./whatsapp/sessions.ts";

const DATA_DIR = ".data";
const config = loadWebhookConfig();
const contact = loadDemoContact(config.allowed);
const log = new JobLog(`${DATA_DIR}/joblog.jsonl`);
const guard = new SpendGuard({ ledgerPath: DEFAULT_LEDGER_PATH });

const missing = missingEnv(["MODEL_API_KEY", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "PUBLIC_BASE_URL"]);
const baseUrl = readEnv("PUBLIC_BASE_URL");
if (baseUrl && !/^https:\/\/[^\s/]+/.test(baseUrl)) throw new Error("PUBLIC_BASE_URL must start with https://");

let handle: Handler;
if (missing.length === 0) {
  const metaClient = new MetaClient({ apiKey: readEnv("MODEL_API_KEY")!, guard });
  const conversation = new Conversation({
    store: new SessionStore(`${DATA_DIR}/sessions.json`),
    log,
    messenger: new GraphClient({ token: readEnv("WHATSAPP_ACCESS_TOKEN")!, phoneNumberId: readEnv("WHATSAPP_PHONE_NUMBER_ID")! }),
    models: realModels(metaClient),
    publish: (s) =>
      publishCatalogue(s, DATA_DIR, baseUrl!, {
        enhance: cleanupStep(log, metaClient, s.jobId, (item, reason) => console.log(`Item ${item} of ${s.jobId}: plain cut-out (${reason})`)),
      }),
    dataDir: DATA_DIR,
    callsLeft: (jobId) => MAX_CALLS_PER_JOB - guard.callsForJob(jobId),
  });
  handle = (msg) => conversation.handle(msg);
} else {
  console.warn(`Not replying to traders until these are set: ${missing.join(", ")}`);
  handle = async (msg) => console.log(`Received ${msg.kind} ${msg.id} from ...${msg.from.slice(-4)}; not replying (settings missing)`);
}

const webhook = createWebhook({ config, log, handle });
webhook.recover();

// Bodies over the limit are refused at the socket, before they are read.
const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  maxRequestBodySize: MAX_BODY_BYTES,
  // Never Bun's development error page, which shows source and the stack.
  development: false,
  error(e) {
    console.error(`Request failed: ${e.message}`);
    return new Response("Something went wrong.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
  fetch: (req) => ((req.method === "GET" || req.method === "HEAD") && serveCatalogue(new URL(req.url).pathname, DATA_DIR, contact)) || webhook.fetch(req),
});
console.log(`StallSnap listening on port ${server.port}`);
