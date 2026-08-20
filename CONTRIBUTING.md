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
- `src/canonical.ts` — the normalized usage shape sent to Lago
- `src/queue.ts` — async event queue with backoff
- `src/lago_client.ts` — thin HTTP client to `/events/batch`
- `tests/unit/` — unit tests, organized to mirror `src/`
- `tests/unit/adapters/fixtures/` — captured real provider responses, used by adapter tests

## Adding a provider

1. Capture real fixtures: write a small script that hits the provider and saves responses to `tests/unit/adapters/fixtures/<provider>/`.
2. Write the adapter at `src/adapters/<provider>.ts` that returns `CanonicalUsage`.
3. Write the wrapper at `src/wrappers/<provider>.ts` that intercepts the customer-facing method.
4. Update `detector.ts` to recognize the client class.
5. Update `sdk.ts::wrap()` to dispatch to the new wrapper.
6. Add unit tests against the captured fixtures.

## Pull request checklist

- [ ] Unit tests cover the change
- [ ] Existing tests still pass (`npm test`)
- [ ] TypeScript compiles cleanly (`npm run typecheck`)
- [ ] Linter clean (`npm run lint`)
- [ ] `npm run build` succeeds
- [ ] CHANGELOG.md updated under `## [Unreleased]`
- [ ] Doc updated if public API changed
