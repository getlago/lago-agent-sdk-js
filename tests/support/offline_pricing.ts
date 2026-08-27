/** A `PricingFetcher` with every method stubbed, for tests to extend.
 *
 * Extending `HttpPricingFetcher` and overriding one method is the trap: the other three
 * stay live. `auto_prime_pricing.test.ts` did exactly that and hit `openrouter.ai` on
 * every run, and a future source added to `PricingFetcher` would have gone live in the
 * same silent way. Extending THIS instead means an unoverridden method returns an empty
 * table — the same thing a failed fetch produces, but chosen rather than accidental.
 *
 * Implementing the `PricingFetcher` interface (not subclassing the HTTP one) is what
 * makes that guarantee hold over time: add a method to the interface and this file stops
 * compiling until it is stubbed too.
 */
import type { ModelPrice, OpenRouterTable, PricingFetcher } from "../../src/pricing.js";

export class OfflinePricingFetcher implements PricingFetcher {
  async fetchOpenRouter(): Promise<OpenRouterTable> {
    return { exact: new Map<string, ModelPrice>(), norm: new Map<string, ModelPrice>() };
  }

  async fetchBedrock(_region: string): Promise<Map<string, ModelPrice>> {
    return new Map<string, ModelPrice>();
  }

  async fetchCloudflareWorkersAi(): Promise<Map<string, ModelPrice>> {
    return new Map<string, ModelPrice>();
  }

  async fetchMistralAliases(_apiKey?: string | null): Promise<Map<string, string>> {
    return new Map<string, string>();
  }
}
