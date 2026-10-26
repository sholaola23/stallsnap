// Messy-input suite: job logs after crashes and damage (QA round 1 on PR #3).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobLog } from "../../src/joblog.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joblog-messy-"));
  path = join(dir, "joblog.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a handler that doesn't catch a cut-off step still leaves the job failed, never open", async () => {
  const first = new JobLog(path);
  first.openJob("job:X");
  void first.step("job:X", "model", () => new Promise(() => {}));
  first.close();

  const second = new JobLog(path);
  await second.step("job:X", "model", async () => 1).catch(() => {}); // the handler lets it bubble up
  expect(second.job("job:X")?.status).toBe("failed");
  expect(second.openJobs()).toEqual([]);
  second.close();

  const third = new JobLog(path);
  expect(third.openJobs()).toEqual([]);
  third.close();
});

test("a step that failed before also fails its job when asked again", async () => {
  const log = new JobLog(path);
  log.openJob("j");
  await log.step("j", "k", async () => Promise.reject(new Error("boom"))).catch(() => {});
  expect(log.job("j")?.status).toBe("open"); // the first failure is the caller's to handle
  await log.step("j", "k", async () => 1).catch(() => {});
  expect(log.job("j")?.status).toBe("failed");
  log.close();
});

for (const [name, line] of [
  ["null", "null"],
  ["a message without an id", '{"t":"msg"}'],
  ["an unknown entry type", '{"t":"oops","id":"x"}'],
  ["a job with a made-up status", '{"t":"job","jobId":"j","status":"paused"}'],
  ["a number", "42"],
] as const) {
  test(`a well-formed but wrong line (${name}) stops start-up`, () => {
    writeFileSync(path, `${line}\n{"t":"msg","id":"wamid.1","msg":{}}\n`);
    expect(() => new JobLog(path)).toThrow("damaged at line 1");
  });
}

test("a valid log still loads after the checks", () => {
  writeFileSync(path, '{"t":"msg","id":"wamid.1","msg":{"a":1}}\n{"t":"job","jobId":"j","status":"open"}\n');
  appendFileSync(path, '{"t":"start","jobId":"j","key":"k"}\n');
  const log = new JobLog(path);
  expect(log.pending()).toEqual([{ id: "wamid.1", msg: { a: 1 } }]);
  expect(log.openJobs()).toEqual(["j"]);
  log.close();
});
