import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemo } from "../src/demo.js";
test("official SDK client exercises all five tools over stdio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taskheist-mcp-"));
  const repo = await createDemo(join(dir, "repo"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("src/cli.ts"), "mcp"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      ),
      TASKHEIST_HOME: join(dir, "runs"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "taskheist-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools.length, 5);
    const bad = await client.callTool({
      name: "get_task_status",
      arguments: { runId: "../../outside" },
    });
    assert.equal(bad.isError, true);
    const started = await client.callTool({
      name: "start_task",
      arguments: { repo, request: "fix webhook" },
    });
    const parsed = JSON.parse((started.content as { text: string }[])[0].text);
    assert.ok(parsed.runId);
    for (const name of [
      "get_task_status",
      "list_findings",
      "get_task_report",
      "cancel_task",
    ]) {
      const result = await client.callTool({
        name,
        arguments: { runId: parsed.runId },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
    }
  } finally {
    await client.close();
  }
});
