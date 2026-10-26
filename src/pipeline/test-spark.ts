// A scripted fake Spark for the pricing loop: each turn returns the given
// tool calls (or plain text), with a reasoning item to check replay.
import { fakeMeta } from "../meta/test-fakes.ts";

export type ScriptedCall = { name: string; args: unknown } | { name: string; raw: string };

export function scriptedSpark(turns: (ScriptedCall[] | string)[]) {
  let turn = 0;
  return fakeMeta(() => {
    const t = turns[turn++];
    if (t === undefined) throw new Error("Spark called more times than scripted");
    const reasoning = { type: "reasoning", id: `rs_${turn}`, summary: [], encrypted_content: `enc-${turn}` };
    if (typeof t === "string") {
      return { status: "completed", output: [reasoning, { type: "message", role: "assistant", content: [{ type: "output_text", text: t }] }], usage: { input_tokens: 800, output_tokens: 100 } };
    }
    return {
      status: "completed",
      output: [
        reasoning,
        ...t.map((c, i) => ({ type: "function_call", call_id: `call_${turn}_${i}`, name: c.name, arguments: "raw" in c ? c.raw : JSON.stringify(c.args), status: "completed" })),
      ],
      usage: { input_tokens: 800, output_tokens: 150 },
    };
  });
}

export const setPrice = (item: number, price_naira: number, unit: string, quote: string) => ({ name: "set_price", args: { item, price_naira, unit, quote } });
export const flag = (item: number, question: string) => ({ name: "flag_missing_price", args: { item, question } });
