#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, redact } from "./store.js";
import { Service } from "./service.js";
import { startMcp } from "./mcp.js";
import { createDemo, demoCheck } from "./demo.js";
import { startDashboard } from "./dashboard.js";
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(resolve(process.env.TASKHEIST_HOME ?? ".taskheist"));
  await store.recover();
  const service = new Service(store);
  if (cmd === "dashboard") {
    const port = args[0] === undefined ? 4317 : Number(args[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error("Port must be an integer from 1 to 65535");
    const dashboard = await startDashboard(service, { port });
    console.log(`Heist Room: ${dashboard.url}`);
    process.once("SIGINT", () => {
      void dashboard.close();
    });
    return;
  }
  process.on("SIGINT", () => {
    void service.shutdown();
  });
  if (cmd === "mcp") {
    startMcp(service);
    return;
  }
  if (cmd === "start" || cmd === "demo") {
    let input: unknown;
    if (cmd === "start") {
      if (!args[0]) throw Error("Usage: taskheist start task.json");
      input = JSON.parse(await readFile(resolve(args[0]), "utf8"));
    } else {
      const repo = await createDemo(join(store.root, `demo-${randomUUID()}`));
      input = {
        repo,
        request:
          "Make webhook processing idempotent so duplicate events do not credit an account twice.",
        checks: [demoCheck],
        provider: args.includes("--real") ? "openai" : "mock",
      };
    }
    const started = await service.start(input);
    console.log(JSON.stringify(started));
    let count = 0;
    const timer = setInterval(() => {
      void service
        .status(started.runId)
        .then((s) => {
          for (const e of s.events.slice(count))
            console.error(`${e.seq}. ${e.message}`);
          count = s.events.length;
        })
        .catch(() => {});
    }, 500);
    const run = await service.wait(started.runId);
    clearInterval(timer);
    console.log(await service.report(run.id, "markdown"));
    if (run.state !== "completed") process.exitCode = 2;
    return;
  }
  const id = args[0];
  if (cmd === "status")
    console.log(JSON.stringify(await service.status(id), null, 2));
  else if (cmd === "findings")
    console.log(JSON.stringify(await service.findings(id), null, 2));
  else if (cmd === "cancel")
    console.log(JSON.stringify(await service.cancel(id)));
  else if (cmd === "report") {
    const format = args.includes("--markdown") ? "markdown" : "json";
    const report = await service.report(id, format);
    const text =
      typeof report === "string" ? report : JSON.stringify(report, null, 2);
    const out = args.indexOf("--out");
    if (out >= 0) {
      if (!args[out + 1]) throw Error("--out requires a file");
      await writeFile(resolve(args[out + 1]), text);
    } else console.log(text);
  } else
    console.log(
      "TaskHeist — One mission. Three agents. Every move checked.\nCommands: start task.json | demo [--real] | status ID | findings ID | cancel ID | report ID [--markdown] [--out FILE] | mcp | dashboard [PORT]",
    );
}
main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
