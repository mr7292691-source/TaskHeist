import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Service } from "./service.js";
import { redact, terminal } from "./store.js";
import type { RunData } from "./schema.js";

// This is deliberately an allowlist. Raw model responses, read contents, prompts,
// environment, provider context, and host paths never enter the dashboard API.
export function publicRun(r: RunData) {
  const clean = (value: unknown): any =>
    typeof value === "string"
      ? redact(value)
          .replace(/\b(Bearer\s+)[\w.\-]+/gi, "$1[REDACTED]")
          .replace(
            /((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi,
            "$1[REDACTED]",
          )
      : Array.isArray(value)
        ? value.map(clean)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, clean(v)]),
            )
          : value;
  return clean({
    id: r.id,
    title: r.task.request,
    createdAt: r.createdAt,
    state: r.state,
    mock: r.mock,
    round: r.round,
    maxRounds: r.task.rounds,
    tokens: r.tokens,
    cost: r.cost,
    revision: r.revision,
    reason:
      r.state === "failed"
        ? "Run failed. Inspect local diagnostics for details."
        : r.reason,
    criteria: r.criteria,
    events: r.events.map((e) => ({
      ...e,
      message:
        e.state === "failed"
          ? "Run failed. Inspect local diagnostics for details."
          : e.message,
    })),
    findings: r.findings,
    patches: r.patches.map((p) => ({
      round: p.round,
      revision: p.revision,
      diff: p.diff,
    })),
    evidence: r.evidence,
    terminal: terminal(r.state),
  });
}

export async function startDashboard(
  service: Service,
  options: { port?: number } = {},
) {
  const csrf = randomBytes(24).toString("hex");
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    void (async () => {
      const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
      const origin = `http://${host}`;
      if (
        req.headers.host !== host &&
        req.headers.host !==
          `localhost:${(server.address() as { port: number }).port}`
      ) {
        res.writeHead(403).end("Invalid host");
        return;
      }
      if (
        req.headers.origin &&
        ![origin, origin.replace("127.0.0.1", "localhost")].includes(
          req.headers.origin,
        )
      ) {
        res.writeHead(403).end("Invalid origin");
        return;
      }
      if (req.headers["sec-fetch-site"] === "cross-site") {
        res.writeHead(403).end("Cross-site request denied");
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      const url = new URL(req.url ?? "/", origin);
      const json = (data: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      };
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(url.pathname)
      ) {
        const name =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        res.setHeader(
          "Content-Type",
          name.endsWith("html")
            ? "text/html; charset=utf-8"
            : name.endsWith("js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
        );
        res.end(await readFile(new URL(`../web/${name}`, import.meta.url)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/runs") {
        json({
          csrf,
          runs: (await service.store.list()).map((r) => {
            const p = publicRun(r);
            return {
              id: p.id,
              title: p.title,
              state: p.state,
              mock: p.mock,
              createdAt: p.createdAt,
            };
          }),
        });
        return;
      }
      const match = /^\/api\/runs\/([^/]+)(?:\/(events|cancel|report))?$/.exec(
        url.pathname,
      );
      if (!match) {
        res.writeHead(404).end("Not found");
        return;
      }
      const id = z.string().uuid().parse(match[1]);
      const action = match[2];
      if (req.method === "POST" && action === "cancel") {
        if (req.headers["x-taskheist-csrf"] !== csrf) {
          res.writeHead(403).end("Invalid cancellation token");
          return;
        }
        json(await service.cancel(id));
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end("Method not allowed");
        return;
      }
      const run = publicRun(await service.store.get(id));
      if (!action) {
        json(run);
        return;
      }
      if (action === "report") {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="taskheist-${id}.json"`,
        );
        json(run);
        return;
      }
      if (action !== "events") {
        res.writeHead(404).end("Not found");
        return;
      }
      const value =
        req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
      if (
        typeof value !== "string" ||
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) > (run.events.at(-1)?.seq ?? 0)
      ) {
        res.writeHead(409).end("Invalid event cursor; reload run");
        return;
      }
      let cursor = Number(value),
        closed = false,
        busy = false,
        previous = "";
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 1000\n\n");
      streams.add(res);
      const emit = (snapshot: ReturnType<typeof publicRun>) => {
        for (const event of snapshot.events) {
          if (event.seq <= cursor) continue;
          res.write(
            `id: ${event.seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`,
          );
          cursor = event.seq;
        }
        const encoded = JSON.stringify(snapshot);
        if (encoded !== previous) {
          res.write(`event: snapshot\ndata: ${encoded}\n\n`);
          previous = encoded;
        }
        if (res.writableLength > 2_000_000) res.destroy();
      };
      emit(run);
      const timer = setInterval(() => {
        if (busy || closed) return;
        busy = true;
        void service.store
          .get(id)
          .then((r) => {
            if (!closed) emit(publicRun(r));
          })
          .catch(() => {
            res.destroy();
          })
          .finally(() => {
            busy = false;
          });
      }, 200);
      const heartbeat = setInterval(() => {
        if (!closed) res.write(": heartbeat\n\n");
      }, 15000);
      res.on("close", () => {
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        streams.delete(res);
      });
    })().catch(() => {
      if (res.headersSent) res.destroy();
      else res.writeHead(400).end("Run unavailable or invalid request");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4317, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    disconnectStreams: () => {
      for (const stream of streams) stream.destroy();
    },
    close: async () => {
      for (const stream of streams) stream.destroy();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
