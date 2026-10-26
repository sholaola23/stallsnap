// Builders for webhook tests. The payload shape follows Meta's Cloud API
// webhook docs; it is not a recorded real webhook. Swap in a recorded one
// once the live number works.
import { createHmac } from "node:crypto";
import type { WebhookConfig } from "./config.ts";

export const SECRET = "test-app-secret";
export const VERIFY = "test-verify-token";
export const TRADER = "447700900123";
export const STRANGER = "447700900999";
export const OUR_NUMBER_ID = "100000000000001";

export const testConfig = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  appSecret: SECRET,
  verifyToken: VERIFY,
  allowed: new Set([TRADER]),
  phoneNumberId: OUR_NUMBER_ID,
  ...over,
});

let seq = 0;
export function message(type: string, fields: Record<string, unknown>, from = TRADER, id?: string) {
  seq++;
  return { from, id: id ?? `wamid.TEST${seq}`, timestamp: String(1_793_000_000 + seq), type, ...fields };
}

export function payload(messages: unknown[], extra: Record<string, unknown> = {}, phoneNumberId = OUR_NUMBER_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "200000000000002",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Trader" }, wa_id: TRADER }],
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

export const sign = (raw: string | Uint8Array, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

export function post(body: unknown, opts: { raw?: string; signature?: string | null } = {}): Request {
  const raw = opts.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = opts.signature === undefined ? sign(raw) : opts.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return new Request("http://localhost/webhook", { method: "POST", headers, body: raw });
}

export const handshake = (params: Record<string, string>) =>
  new Request(`http://localhost/webhook?${new URLSearchParams(params)}`);
