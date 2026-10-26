import { missingEnv, readEnv } from "../env.ts";

export type WebhookConfig = {
  appSecret: string;
  verifyToken: string;
  allowed: ReadonlySet<string>;
  /** When set, messages to any other business number are dropped. */
  phoneNumberId: string | undefined;
};

/**
 * Parses ALLOWED_NUMBERS: international numbers, digits only once spaces,
 * dashes, brackets, dots, a leading "+" or "00" are removed. Separated by
 * commas, semicolons or new lines. Anything that isn't a plausible
 * international number stops start-up, so a typo can't quietly lock a
 * trader out or let someone else in.
 */
export function parseAllowedNumbers(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(/[,;\n]/)) {
    const entry = part.trim();
    if (entry === "") continue;
    let n = entry.replace(/[\s\-().]/g, "");
    if (n.startsWith("+")) n = n.slice(1);
    else if (n.startsWith("00")) n = n.slice(2);
    else if (n.startsWith("0")) {
      throw new Error(`ALLOWED_NUMBERS entry ${JSON.stringify(entry)} looks local; use the international format, for example 447700900123`);
    }
    if (!/^[1-9]\d{7,14}$/.test(n)) {
      throw new Error(`ALLOWED_NUMBERS entry ${JSON.stringify(entry)} is not a phone number`);
    }
    out.add(n);
  }
  return out;
}

/** Reads the webhook settings, or throws naming every missing one. */
export function loadWebhookConfig(env: Record<string, string | undefined> = process.env): WebhookConfig {
  const missing = missingEnv(["APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "ALLOWED_NUMBERS"], env);
  if (missing.length > 0) throw new Error(`Missing settings: ${missing.join(", ")}`);
  const allowed = parseAllowedNumbers(readEnv("ALLOWED_NUMBERS", env)!);
  if (allowed.size === 0) throw new Error("ALLOWED_NUMBERS has no numbers");
  return {
    appSecret: readEnv("APP_SECRET", env)!,
    verifyToken: readEnv("WHATSAPP_VERIFY_TOKEN", env)!,
    allowed,
    phoneNumberId: readEnv("WHATSAPP_PHONE_NUMBER_ID", env),
  };
}
