# Implementation plan

1. Define runtime-validated artifacts, atomic local persistence, bounded processes, and isolated Git snapshots.
2. Implement a Docker-only executor, structured OpenAI/mock providers, and an evidence-gated state machine.
3. Expose a shared asynchronous service through CLI and official MCP SDK.
4. Add the webhook fixture, regression checks, integration tests, and operational documentation.

Defaults: three rounds, ten minutes, 50,000 tokens, no container network, no automatic merge. JSON snapshots are the durable MVP store. Docker absence is an unresolved run, never permission to execute target code on the host.
