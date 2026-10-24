# See TaskHeist in action

These steps use **PowerShell on Windows** from the TaskHeist repository. Keep each long-running command in its own terminal. The dashboard and CLI must start from the same directory so both use the default `.taskheist` run store.

## 1. Prepare the tools

Open PowerShell in the repository and run:

```powershell
cd D:\Software\TaskHeist
node --version
git --version
docker --version
npm ci
npm run build
docker pull node:22-alpine
```

Use Node.js 22.18+ or another supported LTS release, Git, and Docker running with **Linux containers**. `docker --version` only checks the client; `docker info` confirms the engine is running. The demo container uses the preloaded `node:22-alpine` image and does not download packages during a run.

If Docker is unavailable, you can still open the dashboard and inspect earlier runs. A new demo will stop at **needs attention** with an explanation. TaskHeist will not run generated code or tests on your host as a fallback.

## 2. Open the Heist Room

In **terminal A**:

```powershell
cd D:\Software\TaskHeist
npm run dashboard
```

Open **http://127.0.0.1:4317** in your browser. Leave terminal A open. The dashboard reads persisted runs and updates itself; you do not need to refresh it after starting a task.

## 3. Run the offline demo

In **terminal B**:

```powershell
cd D:\Software\TaskHeist
npm run demo
```

The command prints a JSON line containing `runId`, then the final report. Copy the ID. The dashboard should show a new mission with a prominent **SCRIPTED MOCK** badge. The agent decisions in this demo are scripted; the checks run in Docker when Docker is available.

Follow the timeline:

1. The coordinator records the acceptance criterion and assumptions.
2. Builder Ulla records a patch in an isolated copy of the faulty webhook fixture.
3. Mapper Veliya records a suspected duplicate-credit problem. Breaker Veliya runs the regression check.
4. A failed check confirms the problem; the coordinator sends the finding back for correction.
5. Builder applies the correction. Checks run again against the final content revision.
6. The final outcome appears only when the recorded checks pass and blocking findings are resolved.

Use the **Findings**, **Diffs**, and **Tests** tabs to inspect the evidence. Click an evidence link in the timeline to jump to its artifact. A suspected finding and a confirmed failure have different labels. The token count is zero in a mock run; cost is **Unknown** unless pricing has been configured.

You can also inspect the run in PowerShell. Replace `RUN_ID` with the ID printed by the demo:

```powershell
node dist/cli.js status RUN_ID
node dist/cli.js findings RUN_ID
node dist/cli.js report RUN_ID --markdown --out report.md
```

The isolated patch and JSON artifacts are in `.taskheist\RUN_ID\`. The demo does not edit the original fixture or merge the patch.

## 4. Replay and cancel

Choose the run from **Mission Archive**. Drag the event slider backward to see what was known at that point, select **Replay** to advance through recorded events, and choose **Latest** to return to the current view. Later test results should not appear as evidence at an earlier point in the replay. The report download always contains the full public run report.

The **Cancel run** button is active while a run is in progress. For a short demo, the run may finish before you can click it. Cancellation can also be requested from another terminal:

```powershell
node dist/cli.js cancel RUN_ID
```

The dashboard will show the resulting terminal state after the coordinator stops. Cancelling an already completed run leaves its outcome intact.

## 5. Optional: try the real provider

The real provider needs Docker and an OpenAI API key. Set the key in **terminal B** without adding it to a tracked file:

```powershell
$env:OPENAI_API_KEY = "your-key"
npm run demo -- --real
```

The default per-agent model names are in `.env.example`; change them with `TASKHEIST_BUILDER_MODEL`, `TASKHEIST_MAPPER_MODEL`, and `TASKHEIST_BREAKER_MODEL` environment variables if needed. Your account must have access to the selected models. Model behavior and the number of rounds can vary. The real-provider path was type-checked, but a live request was not run during development.

To start a different task, create a JSON task file for a **clean, committed, local Git repository** and use `node dist/cli.js start task.json`. The [README](README.md#cli) explains criteria, checks, limits, and execution boundaries. The deterministic mock adapter is tailored to the webhook fixture; choose `"provider": "openai"` for a different repository.

## 6. Optional: connect an MCP client

Start the server with:

```powershell
node dist/cli.js mcp
```

It exposes `start_task`, `get_task_status`, `list_findings`, `get_task_report`, and `cancel_task`. Use the [MCP configuration example](README.md#mcp-configuration) for a compatible client. Connecting the server gives the client access to this workflow; the client must explicitly call `start_task`.

## 7. Run the project checks

```powershell
npm run format:check
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

`npm test` includes a Docker integration test that **skips explicitly** when Docker is unavailable. The browser test covers live updates, reconnection, replay, evidence links, cancellation, report export, and responsive layout. Its coordinator executor is clearly simulated, so it does not prove container execution. See [verification results](VERIFICATION.md) for the results from this workspace.
