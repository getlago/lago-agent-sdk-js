/** Suite-wide network guard.
 *
 * A unit test that stubs HTTP by patching one function keeps "passing" after the code
 * moves to a different call path — it just starts hitting the real API instead. That is
 * not hypothetical here: `auto_prime_pricing.test.ts` subclassed `HttpPricingFetcher`
 * and overrode a single method, so the inherited OpenRouter fetch went live on every
 * run, and `sdk.test.ts` primed a real `PricingProvider` whose background refresh did
 * the same. `npm test` was making live requests to `openrouter.ai`.
 *
 * Guarding at the DISPATCHER rather than at `globalThis.fetch` is the point: it is the
 * layer every `fetch` call funnels through, so it cannot be sidestepped by a module that
 * captured `fetch` earlier or by a rename of the calling function.
 *
 * `127.0.0.1` stays reachable on purpose. Some properties in this suite — connection
 * reuse, request timeouts — ARE socket behaviour, and the only honest way to test them
 * is against a real server. Allowing loopback keeps those tests real while everything
 * else is sealed.
 *
 * NOTE the one seam this cannot close: `verifySsl: false` makes `LagoClient` pass its own
 * `undici` `Agent` as a per-request `dispatcher`, which bypasses the global one by
 * design. Tests on that path stub `fetch` directly.
 */
import { MockAgent, setGlobalDispatcher } from "undici";

/** Loopback in the forms undici presents an origin in: bare host, or host:port. */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect(LOOPBACK);
setGlobalDispatcher(agent);
