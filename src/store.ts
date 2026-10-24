import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { Run, type RunData } from "./schema.js";
import { setTimeout as delay } from "node:timers/promises";
async function replaceFile(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (
        attempt >= 10 ||
        !["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      await delay(20);
    }
  }
}
export function redact(s: string): string {
  for (const [key, value] of Object.entries(process.env))
    if (
      value &&
      value.length > 7 &&
      /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)
    )
      s = s.split(value).join("[REDACTED]");
  return s.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
}
export class Store {
  private writing: Promise<void> = Promise.resolve();
  constructor(public root: string) {}
  dir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid run ID");
    return join(this.root, id);
  }
  async save(run: RunData) {
    Run.parse(run);
    const snapshot = redact(JSON.stringify(run, null, 2));
    const work = this.writing
      .catch(() => {})
      .then(async () => {
        const dir = this.dir(run.id);
        await mkdir(dir, { recursive: true });
        const temp = join(dir, `run-${process.pid}.tmp`);
        const handle = await open(temp, "w");
        try {
          await handle.writeFile(snapshot);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await replaceFile(temp, join(dir, "run.json"));
      });
    this.writing = work;
    await work;
  }
  async get(id: string) {
    return Run.parse(
      JSON.parse(await readFile(join(this.dir(id), "run.json"), "utf8")),
    );
  }
  async list() {
    await mkdir(this.root, { recursive: true });
    const runs = [];
    for (const id of await readdir(this.root)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        runs.push(await this.get(id));
      } catch {
        /* Incomplete or corrupt entries are not advertised. */
      }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async cancel(id: string) {
    const run = await this.get(id);
    await writeFile(join(this.dir(id), "cancel"), "cancel");
    return run;
  }
  async cancelled(id: string) {
    try {
      await readFile(join(this.dir(id), "cancel"));
      return true;
    } catch {
      return false;
    }
  }
  async recover() {
    await mkdir(this.root, { recursive: true });
    for (const id of await readdir(this.root)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const r = await this.get(id);
      if (!terminal(r.state)) {
        let alive = true;
        try {
          process.kill(r.ownerPid, 0);
        } catch {
          alive = false;
        }
        if (!alive) {
          r.state = "needs_attention";
          r.reason = "Interrupted process; automatic resume is not supported";
          r.events.push({
            seq: r.events.length + 1,
            at: new Date().toISOString(),
            state: r.state,
            message: r.reason,
          });
          await this.save(r);
        }
      }
    }
  }
}
export const terminal = (state: string) =>
  [
    "completed",
    "needs_attention",
    "budget_exceeded",
    "failed",
    "cancelled",
  ].includes(state);
