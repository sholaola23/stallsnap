// The environment variables StallSnap reads. Values live only in the
// environment's secrets; `.env.example` lists these names with no values.
export const ENV_NAMES = [
  "MODEL_API_KEY",
  "APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "ALLOWED_NUMBERS",
  "STALLSNAP_PAID_CALLS",
  "PORT",
] as const;

export type EnvName = (typeof ENV_NAMES)[number];

// Values people paste in while a real secret is still missing. Treating them
// as unset means a placeholder can never be sent to Meta as if it were real.
const PLACEHOLDERS = new Set([
  "",
  "changeme",
  "change-me",
  "change_me",
  "todo",
  "tbd",
  "xxx",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "placeholder",
  "your-key-here",
]);

function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (PLACEHOLDERS.has(v)) return true;
  // "<your key>", "${MODEL_API_KEY}", "..."
  if (/^<.*>$/.test(v) || /^\$\{.*\}$/.test(v) || /^\.+$/.test(v)) return true;
  return false;
}

/** The trimmed value, or undefined when it is missing, blank or a placeholder. */
export function readEnv(
  name: EnvName,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[name];
  if (raw === undefined || isPlaceholder(raw)) return undefined;
  return raw.trim();
}

/** The names from `wanted` that have no usable value. */
export function missingEnv(
  wanted: readonly EnvName[],
  env: Record<string, string | undefined> = process.env,
): EnvName[] {
  return wanted.filter((name) => readEnv(name, env) === undefined);
}
