import type { RunData } from "./schema.js";
export function publish(
  run: RunData,
  event: Omit<RunData["events"][number], "seq" | "at" | "state" | "metrics">,
) {
  run.events.push({
    ...event,
    seq: run.events.length + 1,
    at: new Date().toISOString(),
    state: run.state,
    metrics: {
      round: run.round,
      tokens: run.tokens,
      cost: run.cost,
      revision: run.revision,
    },
  });
}
