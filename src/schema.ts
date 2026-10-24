import { z } from "zod";
export const Criterion = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});
export const Check = z.object({
  id: z.string().min(1),
  criterionIds: z.array(z.string()).min(1),
  command: z.array(z.string().max(2000)).min(1).max(30),
  test: z.string().max(30000).nullable(),
});
export const Task = z.object({
  repo: z.string().min(1),
  request: z.string().min(1).max(20000),
  criteria: z.array(Criterion).max(30).default([]),
  checks: z.array(Check).max(30).default([]),
  provider: z.enum(["mock", "openai"]).default("mock"),
  rounds: z.number().int().min(1).max(10).default(3),
  timeMs: z.number().int().min(100).max(3600000).default(600000),
  tokenLimit: z.number().int().min(100).max(1000000).default(50000),
  network: z.boolean().default(false),
});
export const Finding = z.object({
  id: z.string(),
  agent: z.enum(["mapper", "breaker"]),
  criterionId: z.string(),
  severity: z.enum(["blocking", "warning", "info"]),
  file: z.string(),
  location: z.string(),
  explanation: z.string(),
  evidence: z.array(z.string()),
  suggestedCorrection: z.string(),
  status: z.enum(["hypothesis", "confirmed", "rejected", "resolved"]),
});
export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read"), path: z.string() }),
  z.object({
    type: z.literal("write"),
    path: z.string(),
    content: z.string().max(100000),
  }),
  z.object({ type: z.literal("test"), check: Check }),
]);
export const Output = z.object({
  done: z.boolean(),
  summary: z.string(),
  criteria: z.array(Criterion),
  assumptions: z.array(z.string()),
  behavior: z.array(
    z.object({
      criterionId: z.string(),
      description: z.string(),
      evidence: z.array(z.string()),
      hypothesis: z.boolean(),
    }),
  ),
  findings: z.array(Finding),
  actions: z.array(Action).max(12),
});
export const Evidence = z.object({
  id: z.string(),
  checkId: z.string(),
  criterionIds: z.array(z.string()),
  command: z.array(z.string()),
  exitCode: z.number().nullable(),
  output: z.string(),
  durationMs: z.number(),
  revision: z.string(),
  timedOut: z.boolean(),
});
export const State = z.enum([
  "queued",
  "planning",
  "building",
  "reviewing",
  "verifying",
  "completed",
  "needs_attention",
  "budget_exceeded",
  "failed",
  "cancelled",
]);
export const Event = z.object({
  agent: z.enum(["coordinator", "builder", "mapper", "breaker"]).optional(),
  kind: z
    .enum(["status", "activity", "handoff", "patch", "finding", "test"])
    .optional(),
  activity: z.enum(["working", "idle"]).optional(),
  refs: z
    .array(
      z.object({ type: z.enum(["patch", "finding", "test"]), id: z.string() }),
    )
    .optional(),
  finding: Finding.optional(),
  metrics: z
    .object({
      round: z.number(),
      tokens: z.number(),
      cost: z.number().nullable(),
      revision: z.string(),
    })
    .optional(),
  seq: z.number(),
  at: z.string(),
  state: State,
  message: z.string(),
});
export const Patch = z.object({
  round: z.number(),
  revision: z.string(),
  files: z.array(z.string()),
  diff: z.string(),
});
export const Run = z.object({
  reads: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      revision: z.string(),
      path: z.string(),
      content: z.string(),
    }),
  ),
  id: z.string().uuid(),
  task: Task,
  state: State,
  createdAt: z.string(),
  ownerPid: z.number(),
  round: z.number(),
  mock: z.boolean(),
  criteria: z.array(Criterion),
  assumptions: z.array(z.string()),
  events: z.array(Event),
  findings: z.array(Finding),
  evidence: z.array(Evidence),
  patches: z.array(Patch),
  outputs: z.array(
    z.object({
      agent: z.string(),
      phase: z.string(),
      revision: z.string(),
      output: Output,
    }),
  ),
  revision: z.string(),
  workspace: z.string(),
  tokens: z.number(),
  cost: z.number().nullable(),
  reason: z.string(),
  cancelRequested: z.boolean(),
});
export type RunData = z.infer<typeof Run>;
export type TaskData = z.infer<typeof Task>;
export type AgentOutput = z.infer<typeof Output>;
export type CheckData = z.infer<typeof Check>;
export type EvidenceData = z.infer<typeof Evidence>;
export type Role = "planner" | "builder" | "mapper" | "breaker";
