import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";
import { createDemo, demoCheck } from "../src/demo.js";
import { MockProvider, type Provider } from "../src/provider.js";
import { DockerExecutor, type Executor } from "../src/executor.js";
import { Output, Task, type RunData } from "../src/schema.js";
import { completionProblems, transition } from "../src/coordinator.js";
import { safeRelative, writeRepo, revision } from "../src/workspace.js";
import { command } from "../src/process.js";
// This double tests coordinator decisions only. It never executes target code or claims real verification.
class SimulatedExecutor implements Executor {
  async available() {
    return true;
  }
  async run(
    workspace: string,
    _verifier: string,
    check: typeof demoCheck,
    rev: string,
  ) {
    const fixed = (
      await readFile(join(workspace, "webhook.ts"), "utf8")
    ).includes("WeakMap");
    return {
      id: randomUUID(),
      checkId: check.id,
      criterionIds: check.criterionIds,
      command: check.command,
      revision: rev,
      exitCode: fixed ? 0 : 1,
      output: "SIMULATED test-double evidence",
      durationMs: 0,
      timedOut: false,
    };
  }
}
async function setup(
  executor: Executor = new SimulatedExecutor(),
  provider: Provider = new MockProvider(),
) {
  const dir = await mkdtemp(join(tmpdir(), "taskheist-test-"));
  const repo = await createDemo(join(dir, "repo"));
  const store = new Store(join(dir, "runs"));
  return { dir, repo, store, service: new Service(store, executor, provider) };
}
test("state machine rejects illegal transitions", () => {
  assert.throws(
    () => transition({ state: "queued" } as RunData, "completed", "invalid"),
    /Invalid transition/,
  );
});
test("mock orchestration fixes in round two, preserves source and reloads artifacts", async () => {
  const { repo, service, store } = await setup();
  const before = await revision(repo);
  const { runId } = await service.start({
    repo,
    request: "idempotency",
    checks: [demoCheck],
  });
  const r = await service.wait(runId);
  assert.equal(r.state, "completed", r.reason);
  assert.equal(r.round, 2);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].status, "resolved");
  assert.equal(await revision(repo), before);
  assert.equal((await new Store(store.root).get(runId)).revision, r.revision);
  assert.ok(r.evidence.some((e) => e.exitCode === 1));
  assert.ok(r.patches.at(-1)?.diff.includes("WeakMap"));
  const patchCheck = await command(
    "git",
    ["apply", "--check", join(store.dir(runId), "patch.diff")],
    { cwd: repo },
  );
  assert.equal(patchCheck.exitCode, 0, patchCheck.output);
  assert.equal(
    r.outputs.find((o) => o.agent === "mapper" && o.phase === "initial")?.output
      .findings[0].status,
    "hypothesis",
  );
  assert.deepEqual(
    r.events.map((e) => e.seq),
    r.events.map((_, i) => i + 1),
  );
});
test("round limit stays unresolved", async () => {
  const { repo, service } = await setup();
  const { runId } = await service.start({
    repo,
    request: "fix",
    rounds: 1,
    checks: [demoCheck],
  });
  const r = await service.wait(runId);
  assert.equal(r.state, "needs_attention");
  assert.equal(r.findings[0].status, "confirmed");
});
test("missing, failed, stale checks and blocking hypotheses prevent completion", async () => {
  const { repo, service } = await setup();
  const { runId } = await service.start({
    repo,
    request: "fix",
    checks: [demoCheck],
  });
  const r = await service.wait(runId);
  assert.deepEqual(completionProblems(r, [demoCheck]), []);
  assert.ok(completionProblems(r, []).length);
  r.revision = "changed";
  assert.ok(
    completionProblems(r, [demoCheck]).some((s) => s.includes("Missing")),
  );
  r.revision = r.evidence.at(-1)!.revision;
  r.findings[0].status = "hypothesis";
  assert.ok(
    completionProblems(r, [demoCheck]).some((s) => s.includes("Unresolved")),
  );
  r.findings = [];
  r.evidence.at(-1)!.exitCode = 1;
  assert.ok(completionProblems(r, [demoCheck]).length);
});
test("malformed model output fails cleanly", async () => {
  assert.throws(() => Output.parse({ done: true }));
  const { repo, service } = await setup(undefined, {
    async act() {
      return { output: { bad: true }, inputTokens: 0, outputTokens: 0 };
    },
  });
  const { runId } = await service.start({ repo, request: "fix" });
  assert.equal((await service.wait(runId)).state, "failed");
});
test("paths and protected files are rejected", async () => {
  for (const p of [
    "../a",
    "/etc/passwd",
    "C:/Windows",
    "a\\b",
    ".git/config",
    "a/../../b",
  ])
    assert.throws(() => safeRelative(p));
  const { repo } = await setup();
  for (const p of [
    "tests/check.ts",
    "webhook.test.ts",
    "acceptance.json",
    "AGENTS.md",
  ])
    await assert.rejects(writeRepo(repo, p, "bad"), /Protected/);
});
test("unavailable Docker stops without executing code", async () => {
  let called = false;
  const executor: Executor = {
    available: async () => false,
    run: async () => {
      called = true;
      throw Error("must not run");
    },
  };
  const { repo, service } = await setup(executor);
  const { runId } = await service.start({ repo, request: "fix" });
  assert.equal((await service.wait(runId)).state, "needs_attention");
  assert.equal(called, false);
});
test("cancellation propagates to active provider", async () => {
  const slow: Provider = {
    act: (_c, signal) =>
      new Promise((_, reject) => {
        if (signal.aborted) reject(Error("abort"));
        signal.addEventListener("abort", () => reject(Error("abort")), {
          once: true,
        });
      }),
  };
  const { repo, service } = await setup(undefined, slow);
  const { runId } = await service.start({ repo, request: "fix" });
  await service.cancel(runId);
  assert.equal((await service.wait(runId)).state, "cancelled");
});
test("wall-clock timeout ends run", async () => {
  const slow: Provider = {
    act: (_c, signal) =>
      new Promise((_, reject) => {
        if (signal.aborted) reject(Error("abort"));
        signal.addEventListener("abort", () => reject(Error("abort")), {
          once: true,
        });
      }),
  };
  const { repo, service } = await setup(undefined, slow);
  const { runId } = await service.start({ repo, request: "fix", timeMs: 100 });
  assert.equal((await service.wait(runId)).state, "budget_exceeded");
});
test("token budget exhaustion is terminal", async () => {
  const provider: Provider = {
    async act(c, s) {
      const result = await new MockProvider().act(c, s);
      return { ...result, inputTokens: 1000 };
    },
  };
  const { repo, service } = await setup(undefined, provider);
  const { runId } = await service.start({
    repo,
    request: "fix",
    tokenLimit: 100,
  });
  assert.equal((await service.wait(runId)).state, "budget_exceeded");
});
test("interrupted persisted run is marked honestly", async () => {
  const { repo, service, store } = await setup();
  const { runId } = await service.start({ repo, request: "fix" });
  const r = await service.wait(runId);
  r.state = "building";
  r.ownerPid = 2147483647;
  await store.save(r);
  await new Store(store.root).recover();
  assert.equal((await store.get(runId)).state, "needs_attention");
});
test("bounded process timeout and redaction", async () => {
  const result = await command(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeout: 50 },
  );
  assert.equal(result.timedOut, true);
  process.env.TEST_SECRET = "a-very-secret-value";
  const { repo, service } = await setup(undefined, {
    async act() {
      throw Error("a-very-secret-value");
    },
  });
  const { runId } = await service.start({ repo, request: "fix" });
  assert.ok(
    !(await service.wait(runId)).reason.includes("a-very-secret-value"),
  );
  delete process.env.TEST_SECRET;
});
test("complete offline demo executes real container tests", async (t) => {
  const docker = new DockerExecutor();
  if (!(await docker.available())) {
    t.skip("Docker unavailable: generated code is never executed on host");
    return;
  }
  const { repo, service } = await setup(docker);
  const { runId } = await service.start({
    repo,
    request: "fix webhook",
    checks: [demoCheck],
  });
  const r = await service.wait(runId);
  assert.equal(r.state, "completed", r.reason);
  assert.ok(r.evidence.some((e) => e.exitCode === 1));
  assert.ok(
    r.evidence.some((e) => e.exitCode === 0 && e.output.includes("PASS")),
  );
});
