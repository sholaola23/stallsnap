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
    expect(result.card).toEqual(await card());
  });

  // Live check 30 Oct: a stack of two seasoning sachets came back as two stacks of two, and the old
  // colour and background check let it through because Muse Image had also zoomed in.
  const stack = async (boxes: string, background = "#ffffff") =>
    sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
      <rect width="100%" height="100%" fill="${background}"/>${boxes}</svg>`)).jpeg().toBuffer();
  const sachets = (x: number, y: number, w: number, h: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h / 2 - 2}" fill="#7a3a8a"/><rect x="${x}" y="${y + h / 2}" width="${w}" height="${h / 2}" fill="#9ac060"/>`;

  test("a stack that comes back doubled is refused, even when Muse Image also zoomed in (live check 30 Oct)", async () => {
    const original = await stack(sachets(280, 240, 40, 120));
    const doubled = await stack(sachets(270, 140, 60, 160) + sachets(270, 310, 60, 160));
    const { client } = testClient({ [IMAGE_MODEL]: await answer(doubled) });
    const result = await restyleCard(client, original, "seasoning sachets");
    expect(result.restyled).toBe(false);
    expect(result.reason).toContain("outline changed");
    expect(result.card).toEqual(original);
  });

  test("a zoomed-in clean-up is put back at the cut-out's size and place, on pure white", async () => {
    const original = await stack(sachets(280, 240, 40, 120));
    // Same product, twice as big, on the faint grey ghost lines Muse Image leaves behind.
    const ghost = Array.from({ length: 30 }, (_, i) => `<rect x="0" y="${i * 20}" width="600" height="3" fill="#f0f0f0"/>`).join("");
    const zoomed = await stack(ghost + sachets(260, 180, 80, 240));
    const { client } = testClient({ [IMAGE_MODEL]: await answer(zoomed) });
    const result = await restyleCard(client, original, "seasoning sachets");
    expect(result.restyled).toBe(true);
    const { data } = await sharp(result.card).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...data.subarray((y * 600 + x) * 3, (y * 600 + x) * 3 + 3)];
    expect(at(300, 260).every((c) => c < 200)).toBe(true); // product where the cut-out had it
    for (const [x, y] of [[300, 220], [300, 380], [100, 40], [500, 500]] as const) expect(at(x, y)).toEqual([255, 255, 255]); // nothing outside it
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

  // QA round 1 on #20: a different product with the same outline must also be refused.
  // A synthetic sachet: two-tone packet with a label band and a logo, like the live test cards.
  const sachet = (top = "#e05a1a", label = "#f4d020", logo = "#1a8a2a") => `
    <rect x="250" y="180" width="100" height="240" fill="${top}"/>
    <rect x="250" y="260" width="100" height="50" fill="${label}"/>
    <circle cx="275" cy="350" r="18" fill="${logo}"/>
    <rect x="300" y="380" width="40" height="30" fill="#3a1a10"/>`;
  const draw = (body: string) =>
    sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`)).jpeg().toBuffer();
  const refused = async (original: Buffer, returned: Buffer) => {
    const { client } = testClient({ [IMAGE_MODEL]: await answer(returned) });
    const result = await restyleCard(client, original, "seasoning sachet");
    expect(result).toMatchObject({ restyled: false, card: original });
  };

  test("QA D1: red fabric coming back orange is refused", async () => {
    await refused(await draw(`<rect x="150" y="100" width="300" height="400" fill="#c81414"/>`), await draw(`<rect x="150" y="100" width="300" height="400" fill="#e0641e"/>`));
  });

  test("QA D2: one item coming back as four in a grid with the same outline is refused", async () => {
    const four = [[200, 200], [304, 200], [200, 304], [304, 304]].map(([x, y]) => `<rect x="${x}" y="${y}" width="96" height="96" fill="#c81414"/>`).join("");
    await refused(await draw(`<rect x="200" y="200" width="200" height="200" fill="#c81414"/>`), await draw(four));
  });

  test("QA D3 and D4: another flavour's packet, or another product of the same size, is refused", async () => {
    const original = await draw(sachet());
    await refused(original, await sharp(original).modulate({ hue: 60 }).jpeg().toBuffer());
    await refused(original, await draw(sachet("#c01830", "#ffffff", "#2040c0")));
  });

  test("QA D5: a pile of another grain is refused", async () => {
    const pile = (fill: string) => `<ellipse cx="300" cy="300" rx="150" ry="120" fill="${fill}"/>`;
    await refused(await draw(pile("#b8862a")), await draw(pile("#5a4a3a")));
  });

  test("QA D6: a packet mirrored left to right is refused", async () => {
    const original = await draw(sachet());
    await refused(original, await sharp(original).flop().jpeg().toBuffer());
  });

  test("QA D7: a small extra item beside the product is refused", async () => {
    await refused(await draw(sachet()), await draw(sachet() + `<rect x="355" y="300" width="30" height="60" fill="#2050c0"/>`));
  });

  test("QA control: a slightly brighter copy of the packet is kept", async () => {
    const original = await draw(sachet());
    const { client } = testClient({ [IMAGE_MODEL]: await answer(await sharp(original).modulate({ brightness: 1.06 }).jpeg().toBuffer()) });
    expect((await restyleCard(client, original, "seasoning sachet")).restyled).toBe(true);
  });
});
