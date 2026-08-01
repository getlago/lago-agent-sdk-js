# ADR-002: Repo topology

Status: Accepted. 2026-07-31.

## Context

The repo is a single npm package (`@getlago/agent-sdk`). The gateway needs its own package with its own dependencies (Fastify, prom-client) and a higher Node floor, without touching the SDK's zero-runtime-dependency contract. Beta velocity needs atomic changes and shared fixtures, so a separate repo is out.

## Options

1. npm workspaces: `packages/agent-sdk` + `packages/gateway`.
2. `gateway/` directory with a `file:..` dependency on the root package.
3. Separate repo. Rejected outright: no atomic cross-package changes, duplicated fixtures.

## Decision

**npm workspaces.** Existing code moves to `packages/agent-sdk` via `git mv` (history preserved). The gateway lives in `packages/gateway` and depends on `@getlago/agent-sdk` through the workspace. Root `package.json` becomes private and orchestrates: `build`, `test`, `verify:gateway`, `demo` fan out to workspaces.

Option 2 was rejected because `file:..` makes the gateway depend on the SDK's packed output rather than its workspace source, which breaks atomic refactors and doubles installs.

## Consequences

- Node floors diverge by design: `packages/agent-sdk` keeps `>=18`; `packages/gateway` requires `>=24` (it uses `node:sqlite`, see ADR-003).
- CI: the existing 6-cell matrix keeps running SDK checks on Node 18/20/22. A new job runs gateway checks on Node 24 only.
- `publish.yml` publishes only `packages/agent-sdk`. The gateway image ships separately and is out of scope for the npm pipeline in this beta.
- Paths in docs and CI change once, in the conversion PR, with zero behavior change to the SDK. Pre-existing tests must pass unmodified.
