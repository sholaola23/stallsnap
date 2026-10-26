// Starts the StallSnap server: `bun src/server.ts`.
import { JobLog } from "./joblog.ts";
import { loadWebhookConfig } from "./whatsapp/config.ts";
import { createWebhook } from "./whatsapp/webhook.ts";

const config = loadWebhookConfig();
const log = new JobLog(".data/joblog.jsonl");

const webhook = createWebhook({
  config,
  log,
  // The pipeline arrives in a later PR. Until then a message is only logged,
  // with the number shortened so the log never holds a full phone number.
  handle: async (msg) => {
    console.log(`Received ${msg.kind} ${msg.id} from ...${msg.from.slice(-4)}`);
  },
});

webhook.recover();
const server = Bun.serve({ port: Number(process.env.PORT) || 3000, fetch: webhook.fetch });
console.log(`StallSnap listening on port ${server.port}`);
