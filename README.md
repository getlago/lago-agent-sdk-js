# lago-agent-sdk-js

Monorepo for Lago's JavaScript AI billing stack.

| Package | What it is |
| --- | --- |
| [`packages/agent-sdk`](packages/agent-sdk) | `@getlago/agent-sdk`. Instrument LLM clients in-app and emit usage events to [Lago](https://www.getlago.com). Also exposes the billing engine as `@getlago/agent-sdk/core`. |
| [`packages/gateway`](packages/gateway) | The Lago AI Billing Gateway (beta, in progress). An OpenAI-compatible endpoint that authenticates Lago virtual keys, proxies to providers, and emits priced, attributed usage events with durable delivery. |

Design decisions live in [`docs/adr/`](docs/adr). The build plan is [`PLAN.md`](PLAN.md).

## Development

```bash
npm ci
npm run build
npm test
```

Node >= 18 for the SDK, Node >= 24 to work on the gateway.

## License

MIT. See [LICENSE](LICENSE).
