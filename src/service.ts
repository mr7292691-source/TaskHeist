import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Task, type RunData } from "./schema.js";
import { Store, terminal } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { DockerExecutor, type Executor } from "./executor.js";
import { MockProvider, OpenAIProvider, type Provider } from "./provider.js";
export class Service {
  private jobs = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  constructor(
    public store: Store,
    private executor: Executor = new DockerExecutor(),
    private provider?: Provider,
  ) {}
  async start(input: unknown) {
    const task = Task.parse(input);
    task.repo = await realpath(resolve(task.repo));
    if (process.env.TASKHEIST_REPO_ROOT) {
      const root = await realpath(process.env.TASKHEIST_REPO_ROOT);
      const rel = relative(root, task.repo);
      if (rel.startsWith("..") || resolve(root, rel) !== task.repo)
        throw Error("Repository outside allowed root");
    }
    if (new Set(task.checks.map((c) => c.id)).size !== task.checks.length)
      throw Error("Duplicate check IDs");
    const id = randomUUID();
    const run: RunData = {
      reads: [],
      id,
      task,
      state: "queued",
      createdAt: new Date().toISOString(),
      ownerPid: process.pid,
      round: 0,
      mock: task.provider === "mock",
      criteria: task.criteria,
      assumptions: [],
      events: [
        {
          seq: 1,
          at: new Date().toISOString(),
          state: "queued",
          metrics: { round: 0, tokens: 0, cost: null, revision: "" },
          message:
            task.provider === "mock"
              ? "Queued SCRIPTED MOCK run"
              : "Queued OpenAI run",
        },
      ],
      findings: [],
      evidence: [],
      patches: [],
      outputs: [],
      revision: "",
      workspace: "",
      tokens: 0,
      cost: null,
      reason: "",
      cancelRequested: false,
    };
    await this.store.save(run);
    const controller = new AbortController();
    const promise = new Promise<void>((resolveJob) => {
      setImmediate(() => {
        void (async () => {
          try {
            const provider =
              this.provider ??
              (task.provider === "mock"
                ? new MockProvider()
                : new OpenAIProvider());
            await new Coordinator(this.store, provider, this.executor).run(
              run,
              controller,
            );
          } catch (e) {
            run.state = "failed";
            run.reason = e instanceof Error ? e.message : String(e);
            run.events.push({
              seq: run.events.length + 1,
              at: new Date().toISOString(),
              state: "failed",
              message: "Run failed before coordinator completion.",
            });
            await this.store.save(run);
          } finally {
            this.jobs.delete(id);
            resolveJob();
          }
        })();
      });
    });
    this.jobs.set(id, { controller, promise });
    return { runId: id, state: "queued", mock: run.mock };
  }
  async wait(id: string) {
    await this.jobs.get(id)?.promise;
    return this.store.get(id);
  }
  async status(id: string) {
    const r = await this.store.get(id);
    return {
      runId: r.id,
      state: r.state,
      mock: r.mock,
      round: r.round,
      revision: r.revision,
      tokens: r.tokens,
      cost: r.cost,
      reason: r.reason,
      events: r.events,
    };
  }
  async findings(id: string) {
    return (await this.store.get(id)).findings;
  }
  async cancel(id: string) {
    const r = await this.store.get(id);
    if (terminal(r.state)) return { runId: id, state: r.state };
    await this.store.cancel(id);
    this.jobs.get(id)?.controller.abort();
    return { runId: id, state: "cancellation_requested" };
  }
  async report(id: string, format: "json" | "markdown" = "json") {
    const r = await this.store.get(id);
    if (format === "json") return r;
    return `# TaskHeist ${r.id}\n\n${r.mock ? "**SCRIPTED MOCK — not real model performance.**\n\n" : ""}State: **${r.state}**\n\n${r.reason}\n\nRevision: \`${r.revision}\`\n\nTokens: ${r.tokens}; cost USD: ${r.cost ?? "unknown"}\n\n## Acceptance criteria\n${r.criteria.map((c) => `- ${c.id}: ${c.description}`).join("\n")}\n\n## Assumptions\n${r.assumptions.map((a) => `- ${a}`).join("\n")}\n\n## Timeline\n${r.events.map((e) => `- ${e.seq}. ${e.state}: ${e.message}`).join("\n")}\n\n## Findings\n${r.findings.map((f) => `- ${f.id} (${f.agent}, ${f.status}, ${f.severity}) ${f.file}:${f.location}: ${f.explanation} Evidence: ${f.evidence.join(", ")}`).join("\n") || "None recorded"}\n\n## Observed execution\n${r.evidence.map((e) => `### ${e.checkId}\nCommand: ${JSON.stringify(e.command)}\n\nExit: ${e.exitCode}; duration: ${e.durationMs}ms; timed out: ${e.timedOut}; revision: ${e.revision}\n\n<pre>${e.output.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`).join("\n\n")}\n\nPatch: ${this.store.dir(id)}/patch.diff\n`;
  }
  async shutdown() {
    for (const [id, job] of this.jobs) {
      await this.store.cancel(id);
      job.controller.abort();
    }
    await Promise.all([...this.jobs.values()].map((j) => j.promise));
  }
}
