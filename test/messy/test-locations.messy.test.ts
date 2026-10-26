// CI runs `bun test src` and `bun test test/messy`. A test file anywhere else
// would never run, so its failures would pass CI silently.
import { expect, test } from "bun:test";
import { Glob } from "bun";

test("every test file is somewhere CI runs it", async () => {
  const outside: string[] = [];
  for await (const file of new Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mjs,cjs}").scan({ cwd: new URL("../..", import.meta.url).pathname, onlyFiles: true })) {
    if (file.startsWith("node_modules/")) continue;
    if (!file.startsWith("src/") && !file.startsWith("test/messy/")) outside.push(file);
  }
  expect(outside).toEqual([]);
});
