import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { overlay } from "./cutout.ts";
import { toProducts } from "./find.ts";
import { PhotoError, preparePhoto } from "./photo.ts";
import { photoToCutouts } from "./pipeline.ts";
import { OBJECTS_PER_REQUEST } from "./segment.ts";
import { PHOTO_H, PHOTO_W, samLine, samStream, syntheticStall, testClient, textStream } from "../test/fakes.ts";

const sparkAnswer = JSON.stringify({
  products: [
    { name: "Tomato", x_min: 120, y_min: 330, x_max: 380, y_max: 670 },
    { name: "Blue soap bar", x_min: 620, y_min: 330, x_max: 880, y_max: 670 },
  ],
});

const disc = { id: 1, left: 100, top: 200, right: 300, bottom: 400, fill: (x: number, y: number) => (x - 100) ** 2 + (y - 100) ** 2 <= 100 ** 2 };
const square = { id: 2, left: 500, top: 200, right: 700, bottom: 400, fill: () => true };

describe("photo to cut-outs", () => {
  test("cuts each product from the real photo, with a transparent background", async () => {
    const { client, calls } = testClient({
      "muse-spark-1.3": textStream(sparkAnswer),
      "sam-3.1": samStream(samLine([disc, square])),
    });
    const result = await photoToCutouts(client, await syntheticStall());

    expect(result.products.map((p) => p.name)).toEqual(["Tomato", "Blue soap bar"]);
    expect(result.cutouts).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(calls.map((c) => c.model)).toEqual(["muse-spark-1.3", "sam-3.1"]);

    // SAM got Spark's boxes in photo pixels, in one request.
    const samText = (calls[1]!.body.input as any)[0].content[0].text as string;
    expect(samText).toContain("1<|box;x1=96;y1=198;x2=303;y2=401;w=800;h=600|>");

    // The disc's centre is the photo's own red; its corner is see-through.
    const tomato = sharp(result.cutouts[0]!.png).ensureAlpha();
    const meta = await tomato.metadata();
    const { data } = await tomato.raw().toBuffer({ resolveWithObject: true });
    const w = meta.width!;
    const centre = (Math.floor(meta.height! / 2) * w + Math.floor(w / 2)) * 4;
    expect(data[centre]!).toBeGreaterThan(180);
    expect(data[centre + 2]!).toBeLessThan(60);
    expect(data[centre + 3]).toBe(255);
    expect(data[3]).toBe(0);

    // The catalogue card is a plain white square.
    const card = await sharp(result.cutouts[1]!.card).metadata();
    expect([card.width, card.height]).toEqual([600, 600]);
  });

  test("a product SAM returns no mask for is skipped, not invented", async () => {
    const { client } = testClient({
      "muse-spark-1.3": textStream(sparkAnswer),
      "sam-3.1": samStream(samLine([square])),
    });
    const result = await photoToCutouts(client, await syntheticStall());
    expect(result.cutouts.map((c) => c.name)).toEqual(["Blue soap bar"]);
    expect(result.skipped).toEqual([{ product: result.products[0]!, reason: "no mask" }]);
  });

  test("a sliver of a mask is skipped as too small", async () => {
    const sliver = { ...disc, fill: (x: number) => x < 5 };
    const { client } = testClient({
      "muse-spark-1.3": textStream(sparkAnswer),
      "sam-3.1": samStream(samLine([sliver, square])),
    });
    const result = await photoToCutouts(client, await syntheticStall());
    expect(result.skipped.map((s) => s.reason)).toEqual(["mask too small"]);
  });

  test("SAM finding nothing gives no cut-outs and no error", async () => {
    const { client } = testClient({ "muse-spark-1.3": textStream(sparkAnswer), "sam-3.1": samStream("") });
    const result = await photoToCutouts(client, await syntheticStall());
    expect(result.cutouts).toEqual([]);
    expect(result.skipped).toHaveLength(2);
  });

  test("Spark finding no products makes no SAM call", async () => {
    const { client, calls } = testClient({ "muse-spark-1.3": textStream('{"products":[]}') });
    const result = await photoToCutouts(client, await syntheticStall());
    expect(result.products).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("Spark answering with prose is an error, not an empty catalogue", async () => {
    const { client } = testClient({ "muse-spark-1.3": textStream("I see a tomato and some soap.") });
    await expect(photoToCutouts(client, await syntheticStall())).rejects.toThrow("did not return JSON");
  });

  test("more than 16 products are split across SAM requests", async () => {
    const many = Array.from({ length: OBJECTS_PER_REQUEST + 3 }, (_, i) => ({
      name: `item ${i}`,
      x_min: (i % 10) * 100,
      y_min: Math.floor(i / 10) * 400,
      x_max: (i % 10) * 100 + 90,
      y_max: Math.floor(i / 10) * 400 + 300,
    }));
    const { client, calls } = testClient({
      "muse-spark-1.3": textStream(JSON.stringify({ products: many })),
      "sam-3.1": samStream(""),
    });
    await photoToCutouts(client, await syntheticStall());
    const samCalls = calls.filter((c) => c.model === "sam-3.1");
    expect(samCalls).toHaveLength(2);
    expect(((samCalls[1]!.body.input as any)[0].content[0].text as string).startsWith("<0f>17<|box")).toBe(true);
  });

  test("the overlay is the photo's size", async () => {
    const { client } = testClient({
      "muse-spark-1.3": textStream(sparkAnswer),
      "sam-3.1": samStream(samLine([disc, square])),
    });
    const result = await photoToCutouts(client, await syntheticStall());
    const meta = await sharp(await overlay(result.photo, result.products, result.masks)).metadata();
    expect([meta.width, meta.height]).toEqual([PHOTO_W, PHOTO_H]);
  });
});

describe("messy Spark product lists", () => {
  test("clamps, reorders and filters boxes", () => {
    const products = toProducts(
      {
        products: [
          { name: "  Peak   milk ", x_min: 1001, y_min: -5, x_max: 500, y_max: 500 }, // swapped x, out of range
          { name: "", x_min: 0, y_min: 0, x_max: 100, y_max: 100 }, // no name
          { name: "N/A box", x_min: "10", y_min: 0, x_max: 100, y_max: 100 }, // string coordinate
          { name: "dot", x_min: 10, y_min: 10, x_max: 11, y_max: 11 }, // too small
          { name: "peak MILK", x_min: 0, y_min: 0, x_max: 100, y_max: 100 }, // duplicate name
          { name: "rice", x_min: 0, y_min: 0, x_max: Number.NaN, y_max: 100 },
        ],
      },
      800,
      600,
    );
    expect(products).toEqual([{ id: 1, name: "Peak milk", box: { left: 400, top: 0, right: 800, bottom: 300 } }]);
  });

  test("anything that isn't a product list gives no products", () => {
    for (const raw of [null, 42, "products", { products: "many" }, {}]) expect(toProducts(raw, 800, 600)).toEqual([]);
  });

  test("ids stay 1..n after filtering, so SAM ids match", () => {
    const products = toProducts(
      { products: [{ name: "", x_min: 0, y_min: 0, x_max: 9, y_max: 9 }, { name: "garri", x_min: 0, y_min: 0, x_max: 500, y_max: 500 }] },
      800,
      600,
    );
    expect(products.map((p) => p.id)).toEqual([1]);
  });
});

describe("preparing the photo", () => {
  test("a file that isn't an image gets a plain message", async () => {
    await expect(preparePhoto(Buffer.from("not a photo"))).rejects.toBeInstanceOf(PhotoError);
  });

  test("a tiny photo is refused", async () => {
    const tiny = await sharp({ create: { width: 120, height: 90, channels: 3, background: "#888" } }).jpeg().toBuffer();
    await expect(preparePhoto(tiny)).rejects.toThrow("too small");
  });

  test("a big photo is shrunk to 1600px on its longest side", async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#888" } }).jpeg().toBuffer();
    const photo = await preparePhoto(big);
    expect([photo.width, photo.height]).toEqual([1600, 1200]);
  });

  test("a phone photo stored sideways is turned upright first", async () => {
    const sideways = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#888" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const photo = await preparePhoto(sideways);
    expect([photo.width, photo.height]).toEqual([600, 800]);
  });

  test("a PNG with transparency becomes a JPEG on white", async () => {
    const png = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const photo = await preparePhoto(png);
    const { data } = await sharp(photo.jpeg).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(250);
  });
});
