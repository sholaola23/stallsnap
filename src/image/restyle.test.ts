import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { testBudget, testClient } from "../test/fakes.ts";
import { IMAGE_MODEL, likeness, restyleCard } from "./restyle.ts";

// A catalogue card: the product (a red disc) on white, as cutOut makes it.
async function card(extra = "", fill = "#d01010", background = "#ffffff"): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="100%" height="100%" fill="${background}"/>
    <circle cx="300" cy="300" r="200" fill="${fill}"/>${extra}</svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}
const answer = async (picture: Buffer) => JSON.stringify({ data: [{ b64_json: picture.toString("base64") }], output_format: "jpeg" });

describe("Muse Image tidies a real cut-out", () => {
  test("a faithful clean-up is used, and the request forbids look-ups and new objects", async () => {
    const original = await card();
    const tidied = await sharp(original).modulate({ brightness: 1.08 }).jpeg().toBuffer();
    const { client, calls, budget } = testClient({ [IMAGE_MODEL]: await answer(tidied) });
    const result = await restyleCard(client, original, "red ankara fabric");
    expect(result.restyled).toBe(true);
    expect(result.card).not.toEqual(original);
    const body = calls[0]!.body;
    expect(body.tool_enablement).toEqual({ enable_image_search: false, enable_web_search: false, enable_shell: false });
    expect(String(body.prompt)).toContain("Do not add, remove, replace or redraw any object");
    expect(String(body.prompt)).toContain("red ankara fabric");
    expect((body.images as { image_url: string }[])[0]!.image_url).toBe(`data:image/jpeg;base64,${original.toString("base64")}`);
    expect(budget.runSpendUsd).toBeCloseTo(0.01);
  });

  test("a different product comes back: the plain cut-out is kept", async () => {
    const { client } = testClient({ [IMAGE_MODEL]: await answer(await card("", "#1030d0")) });
    const original = await card();
    const result = await restyleCard(client, original, "red ankara fabric");
    expect(result.restyled).toBe(false);
    expect(result.reason).toContain("product changed too much");
    expect(result.card).toEqual(original);
  });

  test("an extra object is added: the plain cut-out is kept", async () => {
    const extra = `<rect x="0" y="0" width="200" height="600" fill="#20a020"/>`;
    const { client } = testClient({ [IMAGE_MODEL]: await answer(await card(extra)) });
    const result = await restyleCard(client, await card(), "red ankara fabric");
    expect(result.restyled).toBe(false);
    expect(result.reason).toContain("something was added");
  });

  test("an API error, an empty answer or the spend cap keeps the plain cut-out and never throws", async () => {
    const original = await card();
    for (const [answers, budget] of [
      [{ [IMAGE_MODEL]: 500 }, testBudget()],
      [{ [IMAGE_MODEL]: JSON.stringify({ data: [] }) }, testBudget()],
      [{ [IMAGE_MODEL]: await answer(original) }, testBudget({ live: false })],
    ] as const) {
      const { client } = testClient(answers as Record<string, string | number>, budget);
      const result = await restyleCard(client, original, "x");
      expect(result).toMatchObject({ restyled: false, card: original });
    }
  });

  test("the same card again is free", async () => {
    const original = await card();
    const { client, calls } = testClient({ [IMAGE_MODEL]: await answer(original) });
    await restyleCard(client, original, "x");
    await restyleCard(client, original, "x");
    expect(calls.length).toBe(1);
  });

  test("likeness: the same picture has no change; a whiter background is not counted as change", async () => {
    const original = await card("", "#d01010", "#f6f6f6");
    expect(await likeness(original, original)).toEqual({ colourChange: 0, newShapes: 0 });
    const like = await likeness(original, await card());
    expect(like.colourChange).toBeLessThan(5);
    expect(like.newShapes).toBe(0);
  });
});
