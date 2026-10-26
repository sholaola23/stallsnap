import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobLog, StepFailed, StepInterrupted } from "./joblog.ts";
import { SpendGuard } from "./spend-guard.ts";

let dir: string;
let path: string;
const logs: JobLog[] = [];
const open = () => {
  const log = new JobLog(path);
  logs.push(log);
  return log;
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joblog-"));
  path = join(dir, "joblog.jsonl");
});
afterEach(() => {
  for (const l of logs.splice(0)) l.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("messages", () => {
  test("an id is accepted once, also after a restart", () => {
    const a = open();
    expect(a.accept("wamid.1", { n: 1 })).toBe(true);
    expect(a.accept("wamid.1", { n: 1 })).toBe(false);
    expect(open().accept("wamid.1", { n: 1 })).toBe(false);
  });

  test("a message accepted but not handled is pending after a restart", () => {
    const a = open();
    a.accept("wamid.1", { n: 1 });
    a.accept("wamid.2", { n: 2 });
    a.handled("wamid.1");
    expect(open().pending()).toEqual([{ id: "wamid.2", msg: { n: 2 } }]);
  });
});

describe("steps", () => {
  const paidCall = (guard: SpendGuard, jobId: string, counter: { n: number }) => () =>
    guard.paid({ jobId, what: "fake model", maxUsd: 0.1 }, async () => {
      counter.n++;
      return { value: { items: ["rice"] }, usd: 0.01 };
    });

  test("a finished step returns its saved result after a restart without paying again", async () => {
    const guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
    const calls = { n: 0 };
    const a = open();
    a.openJob("job1");
    expect(await a.step("job1", "transcript:wamid.1", paidCall(guard, "job1", calls))).toEqual({ items: ["rice"] });

    const b = open();
    expect(b.openJobs()).toEqual(["job1"]);
    expect(await b.step("job1", "transcript:wamid.1", paidCall(guard, "job1", calls))).toEqual({ items: ["rice"] });
    expect(calls.n).toBe(1);
    expect(guard.callsForJob("job1")).toBe(1);
  });

  test("a step cut off by a crash is never rerun, so it can't be paid for twice", async () => {
    const guard = new SpendGuard({ ledgerPath: join(dir, "ledger.json"), paidCalls: "on" });
    const calls = { n: 0 };
    const a = open();
    a.openJob("job1");
    // The process "dies" while the paid call is in flight: it never settles.
    void a.step("job1", "cutout:wamid.1", () => new Promise(() => {}));

    const b = open();
    await expect(b.step("job1", "cutout:wamid.1", paidCall(guard, "job1", calls))).rejects.toBeInstanceOf(
      StepInterrupted,
    );
    expect(calls.n).toBe(0);
    expect(guard.callsForJob("job1")).toBe(0);

    // step() fails the job itself, so no caller can leave it open.
    const c = open();
    expect(c.job("job1")).toEqual({ status: "failed", reason: "step cutout:wamid.1 was interrupted by a restart" });
    expect(c.openJobs()).toEqual([]);
  });

  test("a step that failed is not rerun", async () => {
    const a = open();
    a.openJob("j");
    await expect(a.step("j", "k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    let ran = false;
    await expect(
      open().step("j", "k", async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(StepFailed);
    expect(ran).toBe(false);
  });

  test("the same step started twice at once runs once", async () => {
    const a = open();
    a.openJob("j");
    let runs = 0;
    const run = async () => {
      runs++;
      await Bun.sleep(5);
      return runs;
    };
    expect(await Promise.all([a.step("j", "k", run), a.step("j", "k", run)])).toEqual([1, 1]);
    expect(runs).toBe(1);
  });

  test("steps only run in an open job", async () => {
    const a = open();
    await expect(a.step("never-opened", "k", async () => 1)).rejects.toThrow("not open");
    a.openJob("j");
    a.finishJob("j");
    await expect(a.step("j", "k", async () => 1)).rejects.toThrow("not open");
  });
});

describe("the file", () => {
  test("a last line cut short by a crash is dropped and later writes stay readable", () => {
    const a = open();
    a.accept("wamid.1", {});
    a.close();
    logs.pop();
    appendFileSync(path, '{"t":"msg","id":"wamid.2","ms');
    const b = open();
    expect(b.accept("wamid.2", {})).toBe(true);
    expect(b.accept("wamid.3", {})).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(["wamid.1", "wamid.2", "wamid.3"]);
  });

  test("damage before the last line stops start-up", () => {
    writeFileSync(path, 'garbage\n{"t":"msg","id":"a","msg":{}}\n');
    expect(() => new JobLog(path)).toThrow("damaged at line 1");
  });
});
