# ADR-003: Durable event delivery

Status: Accepted. 2026-07-31.

## Context

The SDK's `EventQueue` is memory-only and drops the oldest event on overflow. That is the right trade for in-app instrumentation: never block the host app. It is the wrong trade for a gateway, where a dropped event is a silently wrong invoice. The gateway needs at-least-once delivery to Lago `/events/batch` that survives `kill -9`, with dedupe on Lago's side via `transaction_id` (already assigned at event-build time in this repo).

## Options

1. Embedded SQLite outbox in WAL mode, via `node:sqlite`.
2. Redis Streams.
3. better-sqlite3 (native module).

## Decision

**Embedded SQLite in WAL mode via `node:sqlite`, behind an `EventTransport` interface.** No new runtime dependency, no native build, crash-safe by construction. Redis Streams stays a future backend behind the same interface for multi-instance deployments; it is not built in this beta. better-sqlite3 is the fallback only if `node:sqlite` proves unfit (it requires Node >= 24 in the gateway package, which ADR-002 already sets).

### Semantics (the contract the crash test enforces)

- **Accepted request**: a request whose usage was extracted and persisted to the outbox before the client response completed. Non-stream: the row is committed before the response body is sent. Stream: the row is committed before the terminating `[DONE]` frame is relayed.
- **kill -9 after persist**: the outbox worker replays on restart with the same `transaction_id`. Lago dedupes. Zero loss, zero duplicates.
- **kill -9 before persist**: the client never got a completed response, so no billing row exists and no invoice line is owed. This is the definition of zero phantom billing.
- **Client abort mid-stream**: still billed. The shim keeps draining the upstream stream after the client disconnects, extracts the final usage, and persists it (see WP5).
- **Backpressure is fail-closed**: when outbox depth reaches its bound, new LLM requests are rejected with a machine-readable 503 before any provider call. Refusing work beats losing billing data. This is deliberately the opposite of the SDK queue's fail-open drop-oldest, and both behaviors are correct for their layer.
- Delivery is at-least-once with exponential backoff (reusing the SDK's 1s to 60s cap discipline). `gw_billing_events_dropped_total` must stay 0 in gateway mode; the metric exists to prove it.

## Consequences

- Single-writer SQLite bounds the beta to one gateway instance per outbox file. Fine for design partners; Redis Streams is the recorded path past that.
- Disk is bounded by the depth cap plus a size check; hitting either triggers backpressure, never eviction.
- The in-memory `EventQueue` remains the SDK default. Nothing changes for instrumentation users.
