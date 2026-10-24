import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { Task } from "./schema.js";
import { Service } from "./service.js";
import { redact } from "./store.js";
const idSchema = z.object({ runId: z.string().uuid() });
export function createServer(service: Service) {
  const server = new McpServer({ name: "taskheist", version: "0.1.0" });
  const reply = async (fn: () => Promise<unknown>) => {
    try {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(await fn()) }],
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: redact(e instanceof Error ? e.message : String(e)),
          },
        ],
      };
    }
  };
  server.registerTool(
    "start_task",
    {
      description:
        "Start an isolated asynchronous coding and verification run. Mock provider is scripted.",
      inputSchema: Task,
    },
    (args) => reply(() => service.start(args)),
  );
  server.registerTool(
    "get_task_status",
    { description: "Read status and ordered timeline", inputSchema: idSchema },
    (args) => reply(() => service.status(args.runId)),
  );
  server.registerTool(
    "list_findings",
    {
      description: "Read findings with observed/hypothesis status",
      inputSchema: idSchema,
    },
    (args) => reply(() => service.findings(args.runId)),
  );
  server.registerTool(
    "get_task_report",
    {
      description: "Export an evidence-backed JSON or Markdown report",
      inputSchema: idSchema.extend({
        format: z.enum(["json", "markdown"]).default("json"),
      }),
    },
    (args) => reply(() => service.report(args.runId, args.format)),
  );
  server.registerTool(
    "cancel_task",
    {
      description: "Cancel a run and stop active execution",
      inputSchema: idSchema,
    },
    (args) => reply(() => service.cancel(args.runId)),
  );
  return server;
}
export function startMcp(service: Service) {
  const handle = serveStdio(() => {
    const server = createServer(service);
    server.server.onclose = () => {
      void service.shutdown();
    };
    return server;
  });
  process.on("SIGINT", () => {
    void service.shutdown().then(() => handle.close());
  });
  console.error("TaskHeist MCP ready");
  return handle;
}
