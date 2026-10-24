# Verification — 2026-10-24

## Heist Room addition

- Formatting, TypeScript checking, and production build passed.
- Core suite: **13 passed, 0 failed, 1 skipped** (Docker unavailable).
- Chromium end-to-end suite: **1 passed**. It verifies live persisted events, forced SSE disconnect and `Last-Event-ID` recovery, complete ordered event history without duplication, cursor validation, replay without future evidence, cancellation through the existing service, evidence links, report download, safe untrusted text rendering, secret redaction, cross-origin/CSRF rejection, and preserved scroll position when reading earlier events.
- Desktop (1440px) and mobile (390px) screenshots were inspected. Mobile horizontal overflow is also asserted by the browser test.
- The E2E executor is explicitly simulated. The test exercises the real coordinator and HTTP/browser integration; it does not claim real container execution or real model performance.
- Built CLI startup printed `Heist Room: http://127.0.0.1:4317`. The in-app preview browser is unavailable in this environment; Chromium testing and screenshot inspection completed independently.

Run the room with `npm run dashboard`; run browser verification with `npm run test:e2e` after `npx playwright install chromium`.

## Core MVP baseline

Environment: Windows, Node.js v22.18.0, npm 11.5.2, Git 2.53.0.windows.2.

| Check                        | Result                                                               |
| ---------------------------- | -------------------------------------------------------------------- |
| `npm run format`             | Passed                                                               |
| `npm run format:check`       | Passed                                                               |
| `npm run typecheck`          | Passed                                                               |
| `npm run build`              | Passed                                                               |
| `npm test`                   | 13 passed, 0 failed, 1 explicitly skipped                            |
| Official MCP SDK client      | All five tools exercised over stdio; invalid input rejected          |
| Exported patch               | `git apply --check` passed against unchanged source fixture          |
| `npm run demo`               | Stopped at `needs_attention`: Docker is not installed/available      |
| Complete real container demo | Not executed; integration test explicitly skipped                    |
| Live OpenAI request          | Not executed; adapter checked against official docs and type-checked |

The test suite's simulated executor validates coordinator logic only. Its results are not real target-code execution. The demo smoke test confirmed the safe Docker-unavailable path and persisted its honest report; it did not verify webhook behavior in a container.

Initial testing revealed a Windows atomic-replacement sharing violation. Bounded retries corrected it, and the subsequent suite passed. Git diff export preserves its trailing newline and was checked for applicability.

With Docker running, preload the image and run the complete demo:

```sh
docker pull node:22-alpine
npm run demo
```

Start the built MCP server:

```sh
node dist/cli.js mcp
```
