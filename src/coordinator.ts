import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Output,
  Evidence,
  type RunData,
  type Role,
  type CheckData,
} from "./schema.js";
import { Store, redact } from "./store.js";
import { files, isolate, readRepo, revision, writeRepo } from "./workspace.js";
import { git } from "./process.js";
import type { Provider, Context } from "./provider.js";
import type { Executor } from "./executor.js";
import { publish } from "./events.js";
const transitions: Record<string, string[]> = {
  queued: ["planning"],
  planning: ["building"],
  building: ["reviewing"],
  reviewing: ["verifying"],
  verifying: ["building", "completed"],
};
export function transition(
  r: RunData,
  state: RunData["state"],
  message: string,
) {
  if (
    !["needs_attention", "budget_exceeded", "failed", "cancelled"].includes(
      state,
    ) &&
    !transitions[r.state]?.includes(state)
  )
    throw Error(`Invalid transition ${r.state} -> ${state}`);
  r.state = state;
  publish(r, { agent: "coordinator", kind: "status", message });
}
export function completionProblems(r: RunData, checks: CheckData[]) {
  const latest = new Map<string, RunData["evidence"][number]>();
  for (const e of r.evidence)
    if (e.revision === r.revision) latest.set(e.checkId, e);
  const problems: string[] = [];
  for (const e of r.evidence)
    if (e.revision === r.revision && (e.exitCode !== 0 || e.timedOut))
      problems.push(`Failing or contradictory evidence: ${e.checkId}`);
  if (!checks.length) problems.push("No required executable checks");
  for (const c of checks) {
    const e = latest.get(c.id);
    if (!e || e.exitCode !== 0 || e.timedOut)
      problems.push(`Missing or failed check: ${c.id}`);
  }
  for (const c of r.criteria)
    if (
      !checks.some(
        (check) =>
          check.criterionIds.includes(c.id) &&
          latest.get(check.id)?.exitCode === 0 &&
          !latest.get(check.id)?.timedOut,
      )
    )
      problems.push(`No supporting executable evidence: ${c.id}`);
  if (!r.criteria.length) problems.push("No acceptance criteria");
  for (const f of r.findings)
    if (
      f.severity === "blocking" &&
      ["hypothesis", "confirmed"].includes(f.status)
    )
      problems.push(`Unresolved finding: ${f.id}`);
  return problems;
}
export class Coordinator {
  constructor(
    private store: Store,
    private provider: Provider,
    private executor: Executor,
  ) {}
  async run(r: RunData, controller: AbortController) {
    const signal = controller.signal;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, r.task.timeMs);
    const poll = setInterval(() => {
      void this.store.cancelled(r.id).then((cancel) => {
        if (cancel) controller.abort();
      });
    }, 200);
    const save = () => this.store.save(r);
    const guard = () => {
      if (signal.aborted)
        throw Error(expired ? "Execution time budget exhausted" : "Cancelled");
      if (r.tokens >= r.task.tokenLimit) throw Error("Token budget exhausted");
    };
    const checks = new Map<string, CheckData>(
      r.task.checks.map((c) => [c.id, c]),
    );
    const execute = async (
      check: CheckData,
      actor: "coordinator" | "mapper" | "breaker" = "coordinator",
    ) => {
      guard();
      if (check.criterionIds.some((id) => !r.criteria.some((c) => c.id === id)))
        throw Error("Unknown check criterion");
      const existing = checks.get(check.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(check))
        throw Error("Protected check cannot be amended");
      checks.set(check.id, check);
      await writeFile(
        join(this.store.dir(r.id), "checks.json"),
        redact(JSON.stringify([...checks.values()], null, 2)),
      );
      const e = Evidence.parse(
        await this.executor.run(
          r.workspace,
          join(this.store.dir(r.id), "verifier"),
          check,
          r.revision,
          signal,
          r.task.network,
        ),
      );
      r.evidence.push(e);
      publish(r, {
        agent: actor,
        kind: "test",
        message: `Check ${e.checkId}: ${e.timedOut ? "timed out" : e.exitCode === 0 ? "passed" : e.exitCode === null ? "could not execute" : "failed"}. Recorded exit ${e.exitCode ?? "unavailable"} against ${e.revision.slice(0, 12)}.`,
        refs: [{ type: "test", id: e.id }],
      });
      await save();
      guard();
      return e;
    };
    const agent = async (role: Role, phase: string, shared: unknown[]) => {
      const identity = role === "planner" ? "builder" : role;
      publish(r, {
        agent: identity,
        kind: "activity",
        activity: "working",
        message:
          phase === "follow-up"
            ? "Investigating shared findings in the bounded follow-up."
            : role === "planner"
              ? "Deriving acceptance criteria and recording assumptions."
              : role === "builder"
                ? `Working on implementation${r.round > 1 ? " corrections" : ""}.`
                : "Starting an independent review of the repository.",
      });
      await save();
      const observations: unknown[] =
        phase === "follow-up"
          ? r.evidence.filter((e) => e.revision === r.revision)
          : role === "builder"
            ? r.evidence.slice(-30)
            : [];
      const results: ReturnType<typeof Output.parse>[] = [];
      for (let step = 0; step < 4; step++) {
        guard();
        const context: Context = {
          role,
          phase,
          round: r.round,
          request: r.task.request,
          criteria: r.criteria,
          requiredChecks: [...checks.values()],
          files: await files(r.workspace),
          observations,
          findings: shared,
          remainingTokens: r.task.tokenLimit - r.tokens,
        };
        // Reserve an upper bound before concurrent model calls, preventing parallel budget overshoot.
        const reservation = r.mock
          ? 0
          : Buffer.byteLength(JSON.stringify(context), "utf8") + 8000;
        if (r.tokens + reservation > r.task.tokenLimit)
          throw Error("Token budget exhausted");
        r.tokens += reservation;
        const answer = await this.provider.act(context, signal);
        r.tokens += answer.inputTokens + answer.outputTokens - reservation;
        const input = Number(process.env.TASKHEIST_INPUT_PRICE),
          output = Number(process.env.TASKHEIST_OUTPUT_PRICE);
        if (
          process.env.TASKHEIST_INPUT_PRICE &&
          process.env.TASKHEIST_OUTPUT_PRICE &&
          Number.isFinite(input) &&
          Number.isFinite(output)
        )
          r.cost =
            (r.cost ?? 0) +
            (answer.inputTokens * input + answer.outputTokens * output) / 1e6;
        guard();
        const out = Output.parse(answer.output);
        r.outputs.push({
          agent: role,
          phase,
          revision: r.revision,
          output: out,
        });
        results.push(out);
        for (const a of out.actions) {
          guard();
          if (a.type === "read") {
            const observed = {
              id: randomUUID(),
              agent: role,
              revision: r.revision,
              path: a.path,
              content: redact(await readRepo(r.workspace, a.path)),
            };
            observations.push(observed);
            r.reads.push(observed);
          } else if (a.type === "write") {
            if (role !== "builder")
              throw Error("Only Builder can write implementation");
            await writeRepo(r.workspace, a.path, a.content);
            r.revision = await revision(r.workspace);
            observations.push({ written: a.path, revision: r.revision });
          } else {
            if (role === "builder" || role === "planner")
              throw Error("Only reviewers can author verifier tests");
            observations.push(
              await execute(a.check, role as "mapper" | "breaker"),
            );
          }
        }
        await save();
        if (out.done) {
          publish(r, {
            agent: identity,
            kind: "activity",
            activity: "idle",
            message: `Finished ${phase}: ${results.reduce((n, o) => n + o.actions.filter((a) => a.type === "read").length, 0)} reads, ${results.reduce((n, o) => n + o.actions.filter((a) => a.type === "write").length, 0)} writes, ${results.reduce((n, o) => n + o.findings.length, 0)} proposed findings. Review claims remain unconfirmed until checked.`,
          });
          await save();
          return results;
        }
      }
      throw Error(`${role} exhausted four structured action turns`);
    };
    const independent = async (phase: string, shared: unknown[]) => {
      const results = await Promise.allSettled([
        agent("mapper", phase, shared),
        agent("breaker", phase, shared),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return results.map((result) => {
        if (result.status !== "fulfilled") throw Error("Review failed");
        return result.value;
      });
    };
    try {
      transition(r, "planning", "Deriving protected acceptance criteria");
      await save();
      r.workspace = await isolate(
        r.task.repo,
        join(this.store.dir(r.id), "workspace"),
      );
      r.revision = await revision(r.workspace);
      const plan = await agent("planner", "planning", []);
      if (!r.criteria.length) r.criteria = plan.flatMap((p) => p.criteria);
      if (
        !r.criteria.length ||
        new Set(r.criteria.map((c) => c.id)).size !== r.criteria.length
      )
        throw Error("Invalid acceptance criteria");
      r.assumptions = plan.flatMap((p) => p.assumptions);
      await writeFile(
        join(this.store.dir(r.id), "acceptance.json"),
        redact(
          JSON.stringify(
            { criteria: r.criteria, assumptions: r.assumptions },
            null,
            2,
          ),
        ),
      );
      await save();
      if (!(await this.executor.available())) {
        transition(
          r,
          "needs_attention",
          "Docker runtime unavailable. Target code was not executed on the host.",
        );
        r.reason = r.events.at(-1)!.message;
        await save();
        return;
      }
      for (r.round = 1; r.round <= r.task.rounds; r.round++) {
        guard();
        transition(
          r,
          "building",
          r.round === 1
            ? "Builder Ulla implementing task"
            : "Builder Ulla applying supported corrections",
        );
        await save();
        await agent("builder", "build", r.findings);
        r.revision = await revision(r.workspace);
        await git(["add", "-N", "."], r.workspace);
        const diff = await git(
          ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"],
          r.workspace,
          false,
        );
        r.patches.push({
          round: r.round,
          revision: r.revision,
          files: await files(r.workspace),
          diff,
        });
        await writeFile(join(this.store.dir(r.id), "patch.diff"), redact(diff));
        publish(r, {
          agent: "builder",
          kind: "patch",
          message: diff
            ? `Round ${r.round} patch recorded. Handing this revision to independent reviewers.`
            : `Round ${r.round}: no diff from the source revision. Handing the current content to reviewers.`,
          refs: [{ type: "patch", id: String(r.round) }],
        });
        transition(
          r,
          "reviewing",
          "Builder produced patch; Mapper and Breaker reviewing independently",
        );
        await save();
        // No Builder explanation or sibling review is included in initial contexts.
        const initial = await independent("initial", []);
        const shared = initial.flat().flatMap((o) => o.findings);
        publish(r, {
          agent: "coordinator",
          kind: "handoff",
          message: `Independent reviews finished; sharing ${shared.length} proposed findings for bounded follow-up.`,
        });
        await save();
        const follow = await independent("follow-up", shared);
        const current = [
          ...shared,
          ...follow.flat().flatMap((o) => o.findings),
        ];
        for (const claim of current) {
          const f = structuredClone(claim);
          if (!r.criteria.some((c) => c.id === f.criterionId))
            throw Error("Finding references unknown criterion");
          f.status = "hypothesis";
          const old = r.findings.find(
            (x) =>
              x.criterionId === f.criterionId &&
              x.file === f.file &&
              x.explanation === f.explanation,
          );
          if (old) {
            old.evidence = [...new Set([...old.evidence, ...f.evidence])];
          } else {
            f.id = `F${r.findings.length + 1}`;
            r.findings.push(f);
          }
        }
        for (const f of r.findings)
          publish(r, {
            agent: f.agent,
            kind: "finding",
            message: `${f.id}: suspected problem — ${f.explanation}`,
            finding: { ...structuredClone(f), status: "hypothesis" },
            refs: [{ type: "finding", id: f.id }],
          });
        transition(
          r,
          "verifying",
          "Running all protected checks against final content hash",
        );
        await save();
        for (const check of checks.values()) await execute(check);
        if ((await revision(r.workspace)) !== r.revision)
          throw Error("Content changed during verification");
        for (const f of r.findings) {
          const linked = r.evidence.filter(
            (e) =>
              e.revision === r.revision &&
              (f.evidence.includes(e.checkId) || f.evidence.includes(e.id)),
          );
          if (linked.some((e) => e.exitCode !== 0 || e.timedOut))
            f.status = "confirmed";
          else if (linked.length > 0) f.status = "resolved";
          else f.status = "hypothesis";
          publish(r, {
            agent: "coordinator",
            kind: "finding",
            message: `${f.id}: ${f.status === "confirmed" ? "confirmed failure" : f.status === "resolved" ? "resolved by passing linked checks" : "still suspected; supporting execution missing"}.`,
            finding: structuredClone(f),
            refs: [
              { type: "finding", id: f.id },
              ...linked.map((e) => ({ type: "test" as const, id: e.id })),
            ],
          });
        }
        if (r.findings.some((f) => f.status === "confirmed"))
          r.events.push({
            seq: r.events.length + 1,
            at: new Date().toISOString(),
            state: r.state,
            message:
              "Review mismatch reproduced by executable verifier evidence",
          });
        const problems = completionProblems(r, [...checks.values()]);
        if (!problems.length) {
          transition(r, "completed", "Verification passed for final revision");
          r.reason =
            "All required checks passed; criteria supported; no unresolved blocking findings";
          await save();
          return;
        }
        r.reason = problems.join("; ");
        r.events.push({
          seq: r.events.length + 1,
          at: new Date().toISOString(),
          state: r.state,
          message: `Verification remained unresolved: ${r.reason}`,
        });
        await save();
      }
      r.round = r.task.rounds;
      transition(r, "needs_attention", `Round limit reached: ${r.reason}`);
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : String(error),
      );
      const cancelled = await this.store.cancelled(r.id);
      transition(
        r,
        cancelled
          ? "cancelled"
          : expired || message.includes("budget exhausted")
            ? "budget_exceeded"
            : signal.aborted
              ? "cancelled"
              : "failed",
        message,
      );
      r.reason = message;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      await save();
    }
  }
}
