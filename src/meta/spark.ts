// One structured-output call to Muse Spark (https://dev.meta.ai/docs/structured-output).
//
// Rules from Meta's docs and our research notes:
// - instructions go in the `developer` role; images only in the user message
// - temperature and top_p are left unset
// - `store: false`, so nothing is kept on Meta's side
// - `max_output_tokens` is generous, because reasoning shares it
// - the schema is strict: every object sets additionalProperties false and
//   lists every key as required
// The output is still parsed and checked by the caller: a schema constrains
// the shape, not whether the content is right.
import type { MetaClient } from "./client.ts";
import { SPARK_MODEL, sparkMaxUsd, sparkUsd } from "./costs.ts";

export class SparkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SparkError";
  }
}

// Spark's per-image token count isn't published, so the worst case assumes
// a large figure per image. The real cost comes from `usage` afterwards.
export const WORST_CASE_TOKENS_PER_IMAGE = 6000;

export type UserPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };

export type SparkJsonCall = {
  jobId: string;
  what: string;
  developer: string;
  user: UserPart[];
  name: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
};

export const jpegDataUrl = (bytes: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;

/** Text of the first output_text part of a Responses body, or undefined. */
export function outputText(res: unknown): string | undefined {
  const output = (res as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    const content = (item as { type?: unknown; content?: unknown } | null)?.content;
    if ((item as { type?: unknown } | null)?.type !== "message" || !Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown } | null;
      if (p?.type === "output_text" && typeof p.text === "string") return p.text;
    }
  }
  return undefined;
}

export async function sparkJson(client: MetaClient, call: SparkJsonCall): Promise<unknown> {
  const textChars = call.developer.length + call.user.reduce((n, p) => n + (p.type === "input_text" ? p.text.length : 0), 0);
  const images = call.user.filter((p) => p.type === "input_image").length;
  const maxInputTokens = Math.ceil(textChars / 2) + images * WORST_CASE_TOKENS_PER_IMAGE + 2000;

  const res = await client.responses(
    { jobId: call.jobId, what: call.what, maxUsd: sparkMaxUsd(maxInputTokens, call.maxOutputTokens) },
    {
      model: SPARK_MODEL,
      store: false,
      max_output_tokens: call.maxOutputTokens,
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: call.developer }] },
        { type: "message", role: "user", content: call.user },
      ],
      text: { format: { type: "json_schema", name: call.name, schema: call.schema, strict: true } },
    },
    (r) => sparkUsd((r as { usage?: unknown }).usage),
  );

  const status = (res as { status?: unknown }).status;
  if (status !== undefined && status !== "completed") {
    throw new SparkError(`${call.what}: response ${String(status)}`);
  }
  const text = outputText(res);
  if (text === undefined) throw new SparkError(`${call.what}: no output text`);
  try {
    return JSON.parse(text);
  } catch {
    throw new SparkError(`${call.what}: output was not JSON`);
  }
}
