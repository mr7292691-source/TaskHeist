import { spawn } from "node:child_process";
import { redact } from "./store.js";
export async function command(
  exe: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    maxOutput?: number;
  } = {},
) {
  const start = Date.now();
  return await new Promise<{
    exitCode: number | null;
    output: string;
    durationMs: number;
    timedOut: boolean;
    truncated: boolean;
  }>((resolve) => {
    let output = "",
      timedOut = false,
      truncated = false,
      settled = false;
    const child = spawn(exe, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        TEMP: process.env.TEMP,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode: code,
        output: redact(output),
        durationMs: Date.now() - start,
        timedOut,
        truncated,
      });
    };
    const abort = () => {
      timedOut = true;
      child.kill();
    };
    const timer = setTimeout(abort, options.timeout ?? 30000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        const next = output + chunk.toString();
        const limit = options.maxOutput ?? 16000;
        if (next.length > limit) truncated = true;
        output = next.slice(-limit);
      });
    child.on("error", (e) => {
      output += e.message;
      finish(null);
    });
    child.on("close", finish);
  });
}
export async function git(args: string[], cwd?: string, trim = true) {
  const r = await command(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      maxOutput: 8000000,
    },
  );
  if (r.exitCode !== 0 || r.truncated)
    throw Error(`Git failed or output exceeded 8MB: ${r.output.slice(-16000)}`);
  return trim ? r.output.trim() : r.output;
}
