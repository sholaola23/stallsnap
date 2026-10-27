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
  // Errors name the entry by position and last 4 digits, so a phone number
  // never ends up in full in the start-up log.
  const describe = (n: number, entry: string) => `ALLOWED_NUMBERS entry ${n} (...${entry.replace(/\D/g, "").slice(-4)})`;
  raw.split(/[,;\n]/).forEach((part, i) => {
    // Invisible formatting marks (copied from phone contacts) are removed first.
    const entry = part.replace(/\p{Cf}/gu, "").trim();
    if (entry === "") return;
    // "+44 (0)7700 900123": the (0) is the trunk prefix, not part of the number.
    let n = entry.replace(/\(0\)/g, "").replace(/[\s\-().]/g, "");
    if (n.startsWith("+")) n = n.slice(1);
    else if (n.startsWith("00")) n = n.slice(2);
    else if (n.startsWith("0")) {
      throw new Error(`${describe(i + 1, entry)} looks local; use the international format, for example 447700900123`);
    }
    // UK and Nigerian numbers never keep the trunk 0 after the country code.
    if (/^(44|234)0/.test(n)) {
      throw new Error(`${describe(i + 1, entry)} has a 0 after the country code; leave it out`);
    }
    if (!/^[1-9]\d{7,14}$/.test(n)) {
      throw new Error(`${describe(i + 1, entry)} is not a phone number`);
    }
    out.add(n);
  });
  return out;
}

/**
 * The number behind the catalogue's "Message on WhatsApp" button, or undefined when
 * DEMO_WHATSAPP_NUMBER is blank (no button). The demo stall uses the WhatsApp test
 * number only: a number that is also a trader's (in ALLOWED_NUMBERS) stops start-up.
 */
export function loadDemoContact(allowed: ReadonlySet<string>, env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = readEnv("DEMO_WHATSAPP_NUMBER", env);
  if (raw === undefined) return undefined;
  const numbers = [...parseAllowedNumbers(raw)];
  if (numbers.length !== 1) throw new Error("DEMO_WHATSAPP_NUMBER must be one phone number");
  if (allowed.has(numbers[0]!)) throw new Error("DEMO_WHATSAPP_NUMBER is a trader's number (in ALLOWED_NUMBERS); use the WhatsApp test number");
  return numbers[0];
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
