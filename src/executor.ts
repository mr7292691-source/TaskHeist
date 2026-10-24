import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { command } from "./process.js";
import type { CheckData, EvidenceData } from "./schema.js";
export interface Executor {
  available(): Promise<boolean>;
  run(
    workspace: string,
    verifier: string,
    check: CheckData,
    revision: string,
    signal: AbortSignal,
    network: boolean,
  ): Promise<EvidenceData>;
}
export class DockerExecutor implements Executor {
  async available() {
    return (
      (
        await command("docker", ["info", "--format", "{{.ServerVersion}}"], {
          timeout: 10000,
        })
      ).exitCode === 0
    );
  }
  async run(
    workspace: string,
    verifier: string,
    check: CheckData,
    revision: string,
    signal: AbortSignal,
    network: boolean,
  ) {
    const id = randomUUID(),
      dir = join(verifier, id);
    await mkdir(dir, { recursive: true });
    if (check.test !== null) await writeFile(join(dir, "test.mjs"), check.test);
    const name = `taskheist-${id}`;
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--pull=never",
      "--network",
      network ? "bridge" : "none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=64",
      "--memory=256m",
      "--cpus=1",
      "--user=65534:65534",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--mount",
      `type=bind,src=${workspace},dst=/workspace,readonly`,
      "--mount",
      `type=bind,src=${dir},dst=/verifier,readonly`,
      "--workdir=/workspace",
      "node:22-alpine",
      ...check.command,
    ];
    try {
      const result = await command("docker", args, { signal, timeout: 60000 });
      return {
        id,
        checkId: check.id,
        criterionIds: check.criterionIds,
        command: check.command,
        revision,
        ...result,
      };
    } finally {
      await command("docker", ["rm", "-f", name], { timeout: 5000 });
    }
  }
}

/**
 * Explicitly demo-only executor. It inspects the known fixture source as data;
 * it never executes repository code or tests on the host.
 */
export class DemoExecutor implements Executor {
  async available() {
    return true;
  }

  async run(
    workspace: string,
    _verifier: string,
    check: CheckData,
    revision: string,
  ): Promise<EvidenceData> {
    const source = await readFile(join(workspace, "webhook.ts"), "utf8");
    const corrected = source.includes("WeakMap") && source.includes("event.id");
    return {
      id: randomUUID(),
      checkId: check.id,
      criterionIds: check.criterionIds,
      command: check.command,
      exitCode: corrected ? 0 : 1,
      output: `SIMULATED DEMO EVIDENCE — Docker unavailable; fixture behavior was inspected without executing repository code. ${corrected ? "The corrected fixture marker is present." : "The faulty fixture marker is present."}`,
      durationMs: 0,
      revision,
      timedOut: false,
    };
  }
}
