# Contributing

## Development setup

```bash
git clone https://github.com/getlago/lago-agent-sdk-js
cd lago-agent-sdk-js
npm install
```

## Run tests

```bash
# Unit tests (fast, no network)
npm test -- tests/unit

# All tests
npm test
```

There is no committed live-provider test tier. Adapter behaviour is pinned by
captured real responses under `tests/unit/adapters/fixtures/`, which is what the
unit tests assert against; re-capture a fixture rather than hand-editing one.

## Build and type-check

```bash
npm run typecheck
npm run build
```

## Where things live

- `src/` — the SDK source
- `src/adapters/` — one file per (provider, access path); transforms provider responses into `CanonicalUsage`
- `src/wrappers/` — one file per (provider SDK, access path); patches client objects in place
- `src/gateway/` — connectors for third-party AI gateways: maps a gateway's own usage-reporting surface into `CanonicalUsage`, consumed by a poller rather than by `wrap()`
- `src/canonical.ts` — the normalized usage shape sent to Lago
- `src/queue.ts` — async event queue with backoff
- `src/lago_client.ts` — thin HTTP client to `/events/batch`
- `src/gateway/` — second front door: gateway usage logs → `CanonicalUsage`, for backfill
- `tests/unit/` — unit tests, organized to mirror `src/`
- `tests/unit/adapters/fixtures/` — captured real provider responses, used by adapter tests
- `tests/unit/adapters/fixtures/capture_*.{ts,py}` — capture scripts; each reads its credential from the environment and scrubs secrets in the same step that writes a fixture into the tree

## Adding a provider

1. Capture real fixtures: write a small script that hits the provider and saves responses to `tests/unit/adapters/fixtures/<provider>/`.
2. Write the adapter at `src/adapters/<provider>.ts` that returns `CanonicalUsage`.
3. Write the wrapper at `src/wrappers/<provider>.ts` that intercepts the customer-facing method.
4. Update `detector.ts` to recognize the client class.
5. Update `sdk.ts::wrap()` to dispatch to the new wrapper.
6. Add unit tests against the captured fixtures.

## Adding a gateway

`gateway/` is a **second front door** into the same kernel, separate from the provider-native
`adapters/` used by `wrap()`. A gateway connector reads a gateway's own usage log and maps it into
`CanonicalUsage` for backfill; there is no client to patch. Two exist: Cloudflare and Databricks.

1. Capture real rows/entries from a live gateway into
   `tests/unit/gateway/adapters/fixtures/<gateway>/`, one file per scenario. Cover both success and
   every failure shape you can produce — failed calls are where the surprises live.
2. Write `src/gateway/adapters/<gateway>.ts` exporting
   `extract<Gateway>Log(entry): CanonicalUsage` and `resolve<Gateway>Subscription(entry): string | null`.
   Keep it a **pure function**: no HTTP, no SDK state.
3. Export both from `src/gateway/adapters/index.ts` under explicitly gateway-scoped names, so no
   gateway is the implicit default.
4. Add `tests/unit/gateway/adapters/<gateway>.test.ts` against the captured fixtures.
5. Add a `## <Gateway> AI Gateway` README section and a `CHANGELOG.md` entry.
6. Mirror the README section here. The Python repo's notebook is a local artefact —
   `examples/` is gitignored there, because a saved notebook carries account
   identifiers and live subscription ids in its cells and outputs — so the README
   section is the reviewable artefact in both repos.

### A connector is only as good as the comparison

The reason the Cloudflare connector reads well is that you can put the gateway's own
dashboard beside Lago and see the same numbers. Two rules protect that, and both were
learned the hard way on Databricks:

- **Emit the gateway's own grouping key as a dimension.** Our `model` is normalized; the
  gateway's page is not. Group Lago by one and the dashboard by the other and the
  comparison fails on naming alone, before any number is even wrong. Attach the key the
  gateway's surface aggregates by, and only keys that are true of the whole row — a
  per-request field on an hourly aggregate is one sampled value dressed up as a property
  of the bucket.
- **Never bill from a surface the gateway UI doesn't show.** Databricks does expose exact
  dollars for its hosted models, in `system.billing.usage` x `list_prices` — on a
  different screen, with no attribution tags, about a day behind. Billing from it would
  produce a number the customer cannot find anywhere, which costs more trust than the
  feature adds. Hosted therefore bills token counts, matching the page they do look at.

### Does the read itself belong in the SDK?

Default: **no.** The adapters stay pure and the fetching lives in the example notebook, as Cloudflare's
does — its whole read is one paginated GET, and an SDK wrapper around that would be indirection for
nothing.

Databricks earned the exception, in `src/gateway/databricks.ts` (a sibling module, so the adapter stays
pure). The bar it cleared, and the one to hold a third gateway to: the read is long enough that a
customer will reimplement it wrong, and the ways it goes wrong lose money silently. Databricks needs a
SQL warehouse, the Statement Execution API, columnar-to-object zipping, chunked result fetching and two
tables reconciled against each other — and the first hand-rolled version in the demo notebook truncated
at chunk 0, which bills a fraction of a wide window with no error at all. If a gateway's read is a loop
over one endpoint, leave it in the notebook.

When it does clear the bar: name it `gateway/<gateway>.ts`, expose a `<Gateway>Source` with an explicit
window and a `readUsage()` returning rows already shaped for `emit()`, add the `backfill<Gateway>()`
one-liner to `LagoSDK`, export it from the `./gateway` subpath, and use a dependency that is already
core (the global `fetch` / `undici`). No scheduler, no cursor store, no credential store — that is the
poller, and it stays out of the SDK.

### Things both existing connectors had to get right

These are the traps, and every one of them cost real debugging:

- **Which cost is authoritative.** Gateway traffic bills from the *gateway's* metered cost, not one we
  compute — it keeps Lago reconcilable against the dashboard the customer looks at. Note the gateway
  may under-report: Cloudflare's `cost` omits additive reasoning tokens, measured at 22.8x low on a
  real call.
- **Token semantics are per-gateway, not per-vendor.** Cloudflare passes Anthropic's cache counts
  through *additively*; Databricks' table folds them *into* `input_tokens`. Same provider, opposite
  conventions. Never assume the vendor's own convention survives the gateway.
- **`provider` must be unmatchable when you cannot price it.** If a gateway bills on its own rate card,
  stamp a provider that hits nothing in `VENDOR_MAP` so the lookup misses honestly. Stamping a real
  vendor name lets a near-miss model string match at 2.5-5x the wrong rate, silently.
- **Idempotency keys must be subscription-scoped.** `transaction_id` is unique org-wide, so
  ``${prefix}_${subscription}_${rowId}`` — an unscoped id silently blocks a row from ever reaching a
  second subscription.
- **Failed calls appear in the log.** Extract them to all-zero so `nonzeroNumeric()` is empty and
  nothing is emitted, rather than billing zeros.
- **Drift.** An unrecognized field must reach `extras`, including one level down inside nested
  `*_details` objects. `drift.test.ts` pins it.

## Pull request checklist

- [ ] Unit tests cover the change
- [ ] Existing tests still pass (`npm test`)
- [ ] TypeScript compiles cleanly (`npm run typecheck`)
- [ ] Linter clean (`npm run lint`)
- [ ] `npm run build` succeeds
- [ ] CHANGELOG.md updated under `## [Unreleased]`
- [ ] Doc updated if public API changed
