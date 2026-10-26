// JobLog: the crash-safe record of inbound messages, jobs and job steps.
//
// It is an append-only JSON-lines file, fsynced after every write, replayed
// on start-up. It gives three guarantees:
//
// 1. Dedupe. `accept(msg)` records a WhatsApp message id once; a webhook
//    Meta delivers again (it retries for up to 7 days) is dropped.
// 2. Nothing accepted is lost. A message is recorded before the webhook is
//    acknowledged and marked handled after; `pending()` lists the ones a
//    crash interrupted, so they can be handled again on restart.
// 3. No double paid calls. `step(jobId, key, run)` records "started" before
//    `run` and the result after. A finished step returns its saved result
//    without running again. A step that started but never finished (the
//    process died mid-call) is never rerun: Meta may already have billed it,
//    so the step throws StepInterrupted and the job fails cleanly.
//
// One process per log file.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type JobStatus = "open" | "done" | "failed";

type Entry =
  | { t: "msg"; id: string; msg: unknown }
  | { t: "handled"; id: string }
  | { t: "job"; jobId: string; status: JobStatus; reason?: string }
  | { t: "start"; jobId: string; key: string }
  | { t: "done"; jobId: string; key: string; value: unknown }
  | { t: "error"; jobId: string; key: string; message: string };

type StepState =
  | { state: "started" }
  | { state: "done"; value: unknown }
  | { state: "error"; message: string };

export class StepInterrupted extends Error {
  constructor(
    readonly jobId: string,
    readonly key: string,
  ) {
    super(`Step ${key} of job ${jobId} was interrupted by a restart; it is not rerun in case it was already paid for`);
    this.name = "StepInterrupted";
  }
}

export class StepFailed extends Error {
  constructor(
    readonly jobId: string,
    readonly key: string,
    readonly original: string,
  ) {
    super(`Step ${key} of job ${jobId} failed earlier: ${original}`);
    this.name = "StepFailed";
  }
}

export class JobLog {
  readonly #path: string;
  readonly #messages = new Map<string, unknown>(); // accepted, not yet handled
  readonly #seen = new Set<string>();
  readonly #jobs = new Map<string, { status: JobStatus; reason?: string }>();
  readonly #steps = new Map<string, StepState>(); // `${jobId}\n${key}`
  readonly #running = new Map<string, Promise<unknown>>(); // steps running in this process
  #fd: number;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) this.#replay(readFileSync(path, "utf8"));
    this.#fd = openSync(path, "a");
  }

  close(): void {
    closeSync(this.#fd);
  }

  /** Records a new message. False if this id was seen before. */
  accept(id: string, msg: unknown): boolean {
    if (this.#seen.has(id)) return false;
    this.#write({ t: "msg", id, msg });
    return true;
  }

  handled(id: string): void {
    if (this.#messages.has(id)) this.#write({ t: "handled", id });
  }

  /** Messages accepted but not handled, oldest first. */
  pending(): { id: string; msg: unknown }[] {
    return [...this.#messages].map(([id, msg]) => ({ id, msg }));
  }

  openJob(jobId: string): void {
    if (!this.#jobs.has(jobId)) this.#write({ t: "job", jobId, status: "open" });
  }

  finishJob(jobId: string): void {
    if (this.#jobs.get(jobId)?.status === "open") this.#write({ t: "job", jobId, status: "done" });
  }

  failJob(jobId: string, reason: string): void {
    if (this.#jobs.get(jobId)?.status === "open") this.#write({ t: "job", jobId, status: "failed", reason });
  }

  job(jobId: string): { status: JobStatus; reason?: string } | undefined {
    return this.#jobs.get(jobId);
  }

  /** Jobs still open, for example after a restart. */
  openJobs(): string[] {
    return [...this.#jobs].filter(([, j]) => j.status === "open").map(([id]) => id);
  }

  /** Runs `run` at most once per (jobId, key), ever. See the header comment. */
  step<T>(jobId: string, key: string, run: () => Promise<T>): Promise<T> {
    const id = `${jobId}\n${key}`;
    const running = this.#running.get(id);
    if (running) return running as Promise<T>;

    const prior = this.#steps.get(id);
    if (prior?.state === "done") return Promise.resolve(prior.value as T);
    if (prior?.state === "error") return Promise.reject(new StepFailed(jobId, key, prior.message));
    if (prior?.state === "started") return Promise.reject(new StepInterrupted(jobId, key));

    if (this.#jobs.get(jobId)?.status !== "open") {
      return Promise.reject(new Error(`Job ${jobId} is not open`));
    }
    this.#write({ t: "start", jobId, key });
    const p = (async () => {
      try {
        const value = await run();
        this.#write({ t: "done", jobId, key, value: value === undefined ? null : value });
        return value;
      } catch (e) {
        this.#write({ t: "error", jobId, key, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        this.#running.delete(id);
      }
    })();
    this.#running.set(id, p);
    return p;
  }

  #write(entry: Entry): void {
    if (entry.t === "done" && JSON.stringify(entry.value) === undefined) {
      throw new Error(`Step ${entry.key} returned a value that can't be saved`);
    }
    writeSync(this.#fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(this.#fd);
    this.#apply(entry);
  }

  #apply(e: Entry): void {
    switch (e.t) {
      case "msg":
        this.#seen.add(e.id);
        this.#messages.set(e.id, e.msg);
        break;
      case "handled":
        this.#messages.delete(e.id);
        break;
      case "job":
        this.#jobs.set(e.jobId, e.reason === undefined ? { status: e.status } : { status: e.status, reason: e.reason });
        break;
      case "start":
        this.#steps.set(`${e.jobId}\n${e.key}`, { state: "started" });
        break;
      case "done":
        this.#steps.set(`${e.jobId}\n${e.key}`, { state: "done", value: e.value });
        break;
      case "error":
        this.#steps.set(`${e.jobId}\n${e.key}`, { state: "error", message: e.message });
        break;
    }
  }

  #replay(text: string): void {
    // A crash mid-write can leave the last line cut short. That write never
    // finished, so it is cut off the file. Damage anywhere else stops start-up.
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    if (complete.length < text.length) truncateSync(this.#path, Buffer.byteLength(complete));
    complete
      .split("\n")
      .slice(0, -1)
      .forEach((line, i) => {
        let entry: Entry;
        try {
          entry = JSON.parse(line) as Entry;
        } catch {
          throw new Error(`Job log ${this.#path} is damaged at line ${i + 1}; not starting`);
        }
        this.#apply(entry);
      });
  }
}
