import { describe, expect, test } from "bun:test";
import { ENV_NAMES, missingEnv, readEnv } from "./env.ts";

describe("readEnv", () => {
  test("returns a real value trimmed", () => {
    expect(readEnv("APP_SECRET", { APP_SECRET: "  s3cret  " })).toBe("s3cret");
  });

  test("treats an unset name as missing", () => {
    expect(readEnv("APP_SECRET", {})).toBeUndefined();
  });
});

describe("missingEnv", () => {
  test("lists only the names without a usable value", () => {
    const env = { MODEL_API_KEY: "k", APP_SECRET: "  ", ALLOWED_NUMBERS: "447700900123" };
    expect(missingEnv(["MODEL_API_KEY", "APP_SECRET", "ALLOWED_NUMBERS"], env)).toEqual([
      "APP_SECRET",
    ]);
  });

  test("reports every name when nothing is set", () => {
    expect(missingEnv(ENV_NAMES, {})).toEqual([...ENV_NAMES]);
  });
});
