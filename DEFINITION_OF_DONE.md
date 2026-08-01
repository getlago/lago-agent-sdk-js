# Definition of Done — AI Gateway for Billing (beta)

Every box below is checked with a pointer to its evidence: a test file that runs in CI, an ADR, a README section, or a PR. The stacked draft PRs are #18 → #19 → #20 → #21 → #22 → #23 → #24 → #25 → #26.

- [x] **ADR-001/002/003 in `docs/adr/`; proxy license verified and recorded.**
  Evidence: [ADR-001](docs/adr/ADR-001-proxy-selection.md) (Bifrost, Apache-2.0 verified against its LICENSE on 2026-07-31, spike results recorded), [ADR-002](docs/adr/ADR-002-repo-topology.md), [ADR-003](docs/adr/ADR-003-durable-event-delivery.md). PR #19.

- [x] **`package.json` name is `@getlago/agent-sdk`; no stale JS name references; npm publish state checked; deprecation note prepared.**
  Evidence: PR #18. `packages/agent-sdk/package.json` (`name`, `publishConfig`). npm state checked 2026-07-31: unscoped `lago-agent-sdk@0.2.0` published, scoped name free; deprecate command documented in [RELEASING.md](RELEASING.md). `@getlago` scope access is NEEDS-HUMAN-CONFIRMATION (PR #18 description).

- [x] **`@getlago/agent-sdk/core` subpath export exists; SDK public API unchanged; pre-existing tests pass unmodified; semver bump recorded.**
  Evidence: PR #20. [core.ts](packages/agent-sdk/src/core.ts), exports map in `packages/agent-sdk/package.json`, [CHANGELOG 0.3.0](packages/agent-sdk/CHANGELOG.md). The 326 pre-existing tests run unmodified in CI (`test:unit`).

- [x] **OpenAI + Anthropic usage extraction verified in JS, fixtures included, stream + non-stream.**
  Evidence: adapters predate this build ([openai_native.ts](packages/agent-sdk/src/adapters/openai_native.ts), [anthropic_native.ts](packages/agent-sdk/src/adapters/anthropic_native.ts), fixtures under `packages/agent-sdk/tests/unit/adapters/fixtures/`); verified through the gateway path in [billing.test.ts](packages/gateway/tests/unit/billing.test.ts) and [harness.test.ts](packages/gateway/tests/integration/harness.test.ts) (both providers, stream + non-stream, incl. the Anthropic cache 5m/1h TTL split).

- [x] **`transaction_id` assigned at event-build time.**
  Evidence: [events.ts](packages/agent-sdk/src/events.ts) (`randomUUID()` at build); [events.test.ts](packages/agent-sdk/tests/unit/events.test.ts) proves a retried batch re-sends identical ids.

- [x] **DurableEventQueue: kill -9 crash test proves zero loss / zero duplicates in CI; fail-closed backpressure tested.**
  Evidence: [outbox.ts](packages/gateway/src/outbox.ts); [crash_recovery.test.ts](packages/gateway/tests/crash/crash_recovery.test.ts) (SIGKILL x3 mid-traffic, every accepted event lands exactly once; runs in the CI `gateway` job); backpressure in [outbox.test.ts](packages/gateway/tests/unit/outbox.test.ts) and [server.test.ts](packages/gateway/tests/unit/server.test.ts) (503 before any provider call).

- [x] **Gateway serves OpenAI-compatible `/v1/chat/completions`, stream + non-stream, across >= 2 providers via translation.**
  Evidence: [server.ts](packages/gateway/src/server.ts); [harness.test.ts](packages/gateway/tests/integration/harness.test.ts) happy path x2 providers x{stream, non-stream} against real Bifrost; the demo drives it with the plain `openai` npm package.

- [x] **Virtual keys hashed at rest; BYOK encrypted at rest; no key material, prompts, or completions in logs or event payloads.**
  Evidence: [store.ts](packages/gateway/src/store.ts) (SHA-256 / AES-256-GCM), [crypto_store.test.ts](packages/gateway/tests/unit/crypto_store.test.ts) greps raw DB rows; [streaming_observability.test.ts](packages/gateway/tests/unit/streaming_observability.test.ts) greps the gateway's own logs and all emitted events for sentinel prompts, completion text, and keys.

- [x] **Budget enforcement: 402 on exhausted, fail-open default + strict mode, both tested; rate limiting via proxy config demonstrated.**
  Evidence: [budget.ts](packages/gateway/src/budget.ts), [budget.test.ts](packages/gateway/tests/unit/budget.test.ts) (402 body, fail-open + alert metric, strict fail-closed, TTL cache call-counting); rate limits via a Bifrost governance VK in [harness.test.ts](packages/gateway/tests/integration/harness.test.ts) (third call 429s, no gateway-built limiter).

- [x] **Client-abort-mid-stream billing test passes.**
  Evidence: [streaming_observability.test.ts](packages/gateway/tests/unit/streaming_observability.test.ts): client aborts after one chunk of a slow stream; the full consumed usage lands, tagged `aborted_by_client`.

- [x] **Idempotency replay test passes; never-under-bill fallback verified through the gateway path.**
  Evidence: [outbox.test.ts](packages/gateway/tests/unit/outbox.test.ts) (same `transaction_id` re-sent after 503 → one event; outbox-level INSERT OR IGNORE); [harness.test.ts](packages/gateway/tests/integration/harness.test.ts) (replay to mock Lago lands once; unknown model → token events + no `llm_cost`, `onError` fired per [billing.test.ts](packages/gateway/tests/unit/billing.test.ts)).

- [x] **`/metrics` exposes the listed metrics; `gw_billing_events_dropped_total == 0` across the whole test suite.**
  Evidence: [metrics.ts](packages/gateway/src/metrics.ts); [streaming_observability.test.ts](packages/gateway/tests/unit/streaming_observability.test.ts) asserts every listed series; the integration suite and load smoke both assert `gw_billing_events_dropped_total 0`.

- [x] **Load smoke (100 RPS / 60s) passes with zero loss.**
  Evidence: [load_smoke.mjs](scripts/load_smoke.mjs), run by `verify:gateway` (CI `verify-gateway` job). Local full run: 6000/6000 requests → 6000 events, outbox drained, dropped 0 (see PR #26 description for the transcript).

- [x] **`npm run verify:gateway` green from a clean clone; CI green on the draft PR(s).**
  Evidence: [verify_gateway.mjs](scripts/verify_gateway.mjs); clean-clone run recorded in PR #26; CI checks on PRs #18–#26 (the `verify-gateway` job runs the same gate).

- [x] **`docker compose up` + `npm run demo` prints `DEMO PASSED`.**
  Evidence: [docker-compose.yml](docker-compose.yml), [demo.mjs](scripts/demo.mjs). The demo creates a virtual key, runs streaming + non-streaming with the plain `openai` package across 2 providers, SIGKILLs and restarts the gateway mid-run, reconciles counts and exact amounts in mock Lago. Transcript in PR #26.

- [x] **Gateway README + failure-semantics table written; PLAN.md reflects reality.**
  Evidence: [packages/gateway/README.md](packages/gateway/README.md) (quickstart, architecture diagram, config reference, failure semantics); [PLAN.md](PLAN.md) updated with the shipped PR ladder.
