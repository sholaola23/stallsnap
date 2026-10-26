import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks Meta's X-Hub-Signature-256 header: "sha256=" then the hex
 * HMAC-SHA256 of the raw request body, keyed with the app secret. It must be
 * the raw bytes: re-serialised JSON changes escaping and breaks the match.
 */
export function signatureIsValid(rawBody: Uint8Array, header: string | null, appSecret: string): boolean {
  if (header === null) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(m[1]!, "hex"));
}

/** Constant-time string compare, for the verify token. */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHmac("sha256", "compare").update(a).digest();
  const hb = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(ha, hb);
}
