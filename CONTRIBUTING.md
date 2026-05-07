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

# Integration tests (require credentials — see env vars in each test)
AWS_BEARER_TOKEN_BEDROCK="..." \
MISTRAL_API_KEY="..." \
LAGO_API_URL="..." LAGO_API_KEY="..." LAGO_EXTERNAL_SUBSCRIPTION_ID="..." \
npm test -- tests/integration

# All tests
npm test
```

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
- `tests/integration/` — live tests, gated on credential env vars

## Adding a provider

1. Capture real fixtures: write a small script that hits the provider and saves responses to `tests/unit/adapters/fixtures/<provider>/`.
2. Write the adapter at `src/adapters/<provider>.ts` that returns `CanonicalUsage`.
3. Write the wrapper at `src/wrappers/<provider>.ts` that intercepts the customer-facing method.
4. Update `detector.ts` to recognize the client class.
5. Update `sdk.ts::wrap()` to dispatch to the new wrapper.
6. Add unit tests against the captured fixtures.
7. Add a live integration test gated on the provider's API key env var.

## Pull request checklist

- [ ] Unit tests cover the change
- [ ] Existing tests still pass (`npm test`)
- [ ] TypeScript compiles cleanly (`npm run typecheck`)
- [ ] Linter clean (`npm run lint`)
- [ ] `npm run build` succeeds
- [ ] CHANGELOG.md updated under `## [Unreleased]`
- [ ] Doc updated if public API changed
