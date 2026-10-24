import { test, expect } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";
import { startDashboard } from "../src/dashboard.js";
import { createDemo, demoCheck } from "../src/demo.js";
import { MockProvider, type Provider } from "../src/provider.js";
import type { Executor } from "../src/executor.js";

test("live room, SSE recovery, evidence, replay, safe rendering, cancellation and report", async ({
  page,
}, testInfo) => {
  const dir = await mkdtemp(join(tmpdir(), "heist-room-"));
  const repo = await createDemo(join(dir, "repo"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pause = true;
  const provider: Provider = {
    async act(c, signal) {
      if (c.role === "builder" && c.round === 2 && pause) await gate;
      if (signal.aborted) throw Error("Cancelled");
      const result = await new MockProvider().act(c, signal);
      return {
        ...result,
        output: {
          ...(result.output as object),
          summary: "PRIVATE_PROMPT_AND_REASONING_DO_NOT_PUBLISH",
        },
      };
    },
  };
  // This executor simulates checks to test the dashboard/coordinator integration.
  // It does not execute generated code, and its output identifies itself explicitly.
  const executor: Executor = {
    available: async () => true,
    async run(workspace, _verifier, check, revision) {
      const fixed = (
        await readFile(join(workspace, "webhook.ts"), "utf8")
      ).includes("WeakMap");
      return {
        id: randomUUID(),
        checkId: check.id,
        criterionIds: check.criterionIds,
        command: check.command,
        revision,
        exitCode: fixed ? 0 : 1,
        output:
          "SIMULATED E2E executor — not real test execution. token=do-not-display-this",
        durationMs: 0,
        timedOut: false,
      };
    },
  };
  const service = new Service(new Store(join(dir, "runs")), executor, provider);
  const dashboard = await startDashboard(service, { port: 0 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const { runId } = await service.start({
      repo,
      request:
        "Make webhook processing idempotent <img src=x onerror=alert(1)>",
      checks: [demoCheck],
    });
    await page.goto(`${dashboard.url}/#run=${runId}`);
    await expect(page.locator("#mock")).toBeVisible();
    await expect(page.locator("#title")).toContainText("<img");
    await expect(page.locator("#title img")).toHaveCount(0);
    await expect(page.locator("#round")).toHaveText("2 / 3");
    await expect(
      page.locator("[data-agent=builder] .activity-status"),
    ).toHaveText("Working");
    await expect(page.locator("#connection")).toContainText("Connected");
    const resumeHeaders: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/events"))
        void req.allHeaders().then((h) => {
          if (h["last-event-id"]) resumeHeaders.push(h["last-event-id"]);
        });
    });
    await page.locator("#timeline").evaluate((el) => {
      el.scrollTop = 0;
    });
    dashboard.disconnectStreams();
    release();
    await expect(page.locator("#status")).toHaveText("completed");
    await expect(page.locator("#outcome")).toContainText("Verification passed");
    expect(await page.locator("#timeline").evaluate((el) => el.scrollTop)).toBe(
      0,
    );
    await expect.poll(() => resumeHeaders.length).toBeGreaterThan(0);
    const persisted = await service.store.get(runId);
    const sequences = await page
      .locator(".event")
      .evaluateAll((nodes) =>
        nodes.map((n) => Number((n as HTMLElement).dataset.seq)),
      );
    expect(sequences).toEqual(persisted.events.map((e) => e.seq));
    expect(new Set(sequences).size).toBe(sequences.length);
    for (const type of ["patch", "finding", "test"]) {
      await page.locator(`button[data-ref^="${type}:"]`).last().click();
      await expect(
        page.locator(`#evidence [id^="artifact-${type}-"]`).first(),
      ).toBeVisible();
    }
    await expect(page.locator("#evidence")).not.toContainText(
      "do-not-display-this",
    );
    const dto = await (
      await page.request.get(`${dashboard.url}/api/runs/${runId}`)
    ).json();
    expect(dto.outputs).toBeUndefined();
    expect(dto.reads).toBeUndefined();
    expect(dto.task).toBeUndefined();
    expect(JSON.stringify(dto)).not.toContain("PRIVATE_PROMPT");
    expect(JSON.stringify(dto)).not.toContain("do-not-display-this");
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#report").click();
    const download = await downloadPromise;
    const report = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(report.state).toBe("completed");
    expect(report.revision).toBe(persisted.revision);
    expect(report.evidence.length).toBeGreaterThan(0);
    await page.locator("#cursor").fill("1");
    await page.locator("#cursor").dispatchEvent("input");
    await expect(page.locator("#status")).toHaveText("queued");
    await expect(page.locator("#outcome")).toBeHidden();
    await expect(page.locator("#evidence")).toContainText("No evidence");
    await expect(page.locator(".event")).toHaveCount(1);
    await page.locator("#play").click();
    await expect.poll(() => page.locator(".event").count()).toBeGreaterThan(1);
    await page.locator("#play").click();
    await page.locator("#latest").click();
    await expect(page.locator("#status")).toHaveText("completed");
    await page.screenshot({
      path: testInfo.outputPath("heist-room-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("heist-room-mobile.png"),
      fullPage: true,
    });
    // A real cancellation request flows through the existing Service and coordinator.
    const slow: Provider = {
      act: (_c, signal) =>
        new Promise((_, reject) => {
          if (signal.aborted) reject(Error("Cancelled"));
          signal.addEventListener("abort", () => reject(Error("Cancelled")), {
            once: true,
          });
        }),
    };
    const other = new Service(service.store, executor, slow);
    const cancelled = await other.start({
      repo,
      request: "Cancellation integration run",
    });
    await page.goto(`${dashboard.url}/#run=${cancelled.runId}`);
    await expect(page.locator("#cancel")).toBeEnabled();
    const csrfDenied = await page.request.post(
      `${dashboard.url}/api/runs/${cancelled.runId}/cancel`,
    );
    expect(csrfDenied.status()).toBe(403);
    await page.locator("#cancel").click();
    await expect(page.locator("#status")).toHaveText("cancelled");
    expect((await other.wait(cancelled.runId)).state).toBe("cancelled");
    await page.goto(`${dashboard.url}/#run=${runId}`);
    await expect(page.locator("#status")).toHaveText("completed");
    await expect(page.locator("#cancel")).toBeDisabled();
    expect(errors).toEqual([]);
    // Explicit protocol contract: header wins over query; only events after cursor.
    const controller = new AbortController();
    const response = await fetch(
      `${dashboard.url}/api/runs/${runId}/events?after=0`,
      { headers: { "Last-Event-ID": "2" }, signal: controller.signal },
    );
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: snapshot")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(
      persisted.events.filter((e) => e.seq > 2).map((e) => e.seq),
    );
    expect(
      (
        await page.request.get(
          `${dashboard.url}/api/runs/${runId}/events?after=999999`,
        )
      ).status(),
    ).toBe(409);
    expect(
      (
        await page.request.get(`${dashboard.url}/api/runs`, {
          headers: { Origin: "https://evil.example" },
        })
      ).status(),
    ).toBe(403);
  } finally {
    release();
    pause = false;
    await page.close();
    await service.shutdown();
    await dashboard.close();
  }
});
