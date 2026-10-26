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
  "PUBLIC_BASE_URL",
] as const;

export type EnvName = (typeof ENV_NAMES)[number];

// Values people paste in while a real secret is still missing. Treating them
// as unset means a placeholder can never be sent to Meta as if it were real.
const PLACEHOLDERS = new Set([
  "",
  "changeme",
  "todo",
  "tbd",
  "n/a",
  "na",
  "nil",
  "none",
  "null",
  "undefined",
  "placeholder",
  "not set",
  "not given",
  "unset",
  "empty",
  "secret",
]);
const PLACEHOLDER_PATTERNS = [
  /^x+$/, // xxx, XXXXXXXX
  /^\*+$/, // ***
  /^\.+$/, // ...
  /^<.*>$/, // <your key>
  /^\$\{?[a-z][a-z0-9]*(_[a-z0-9]+)+\}?$/, // $MODEL_API_KEY, ${MODEL_API_KEY}, not $abc123
  /^change[-_ ]?me$/, // change-me, change_me
  /^(your|my|insert|enter|put|add)[-_ ](the[-_ ])?((api|access|app|verify|phone)[-_ ])?(key|token|secret|number|id|url|value)([-_ ]|$)/, // your-api-key, insert-key-here
  /(key|token|secret|number|id|url|value)[-_ ]?here$/, // key_here
  /^[a-z0-9_-]{1,8}\.{2,}$/, // sk-..., EAAG...
];

/** Removes zero-width characters, surrounding space and matching surrounding quotes. */
function clean(value: string): string {
  let v = value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  while (v.length >= 2 && (v[0] === '"' || v[0] === "'" || v[0] === "`") && v.at(-1) === v[0]) v = v.slice(1, -1).trim();
  return v;
}

function isPlaceholder(name: string, value: string): boolean {
  const v = value.toLowerCase();
  if (PLACEHOLDERS.has(v) || v === name.toLowerCase()) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(v));
}

/** The cleaned value, or undefined when it is missing, blank or a placeholder. */
export function readEnv(
  name: EnvName,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = clean(raw);
  return isPlaceholder(name, value) ? undefined : value;
}

/** The names from `wanted` that have no usable value. */
export function missingEnv(
  wanted: readonly EnvName[],
  env: Record<string, string | undefined> = process.env,
): EnvName[] {
  return wanted.filter((name) => readEnv(name, env) === undefined);
}
