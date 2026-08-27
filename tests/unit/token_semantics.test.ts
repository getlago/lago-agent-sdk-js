/**
 * token_semantics — the one table three billing paths answer from.
 *
 * These tests pin the DECISIONS, not the mechanism: each provider's entry (or
 * deliberate absence) traces to a measurement recorded in token_semantics.ts, and a
 * provider the SDK can stamp without a recorded decision is a red test here — absence
 * must always be a choice somebody made.
 */
import { describe, expect, it } from "vitest";

import {
  INPUT_INCLUDES_CACHE_READ,
  INPUT_INCLUDES_CACHE_WRITE,
  KNOWN_PROVIDERS,
  OPENAI_SHAPED_APIS,
  OUTPUT_INCLUDES_REASONING,
  tokenSemantics,
} from "../../src/token_semantics.js";

// Every provider string the SDK's own code can stamp on a CanonicalUsage today. Kept
// explicit rather than scraped from the source: when an adapter or wrapper grows a new
// stamp, add it BOTH here and (with its measured decision) to KNOWN_PROVIDERS — this
// list failing to cover a stamp is exactly the silent default the roster exists to
// prevent. Gateway backfills additionally pass vendor names through from their logs
// verbatim; those arrive with a surface `api` and are decided by OPENAI_SHAPED_APIS (or
// the vendor's own entry), not by this list.
const STAMPABLE = [
  // adapters/openai_native.ts: inferProvider
  "openai",
  "workers-ai",
  // wrappers/openai.ts: providerHintFor (baseURL table)
  "databricks",
  "snowflake",
  // adapters/anthropic_native.ts, gemini_native.ts, mistral_native.ts
  "anthropic",
  "gemini",
  "mistral",
  // adapters/bedrock_*.ts: providerFromModel
  "amazon",
  "meta",
  "cohere",
  "qwen",
  "google",
  "minimax",
  "nvidia",
  "zai",
  "bedrock",
];

describe("token semantics roster", () => {
  it("every stampable provider has a recorded decision", () => {
    const missing = STAMPABLE.filter((p) => !KNOWN_PROVIDERS.has(p));
    expect(missing).toEqual([]);
  });

  it("the subset sets only name known providers", () => {
    // A set entry for a name nothing can stamp is dead weight at best and a typo
    // silently reverting a measured decision at worst.
    for (const s of [INPUT_INCLUDES_CACHE_READ, INPUT_INCLUDES_CACHE_WRITE, OUTPUT_INCLUDES_REASONING]) {
      for (const p of s) expect(KNOWN_PROVIDERS.has(p)).toBe(true);
    }
  });
});

describe("token semantics decisions", () => {
  it("openai: subset on all three dimensions", () => {
    expect(tokenSemantics("openai", "chat_completions")).toEqual([true, true, true]);
  });

  it("snowflake: additive on all three dimensions", () => {
    // Measured live 2026-08-25: prompt 7 / cached 4805 / completion 6 / total 4818 —
    // Anthropic's additive convention on OpenAI's wire. This single row is what the
    // total_tokens guard, computeCost and deoverlappedTokenTotal all read; if it ever
    // flips, all three flip together or 4,805 tokens bill twice.
    expect(tokenSemantics("snowflake", "chat_completions")).toEqual([false, false, false]);
  });

  it("anthropic: additive", () => {
    expect(tokenSemantics("anthropic", "messages")).toEqual([false, false, false]);
  });

  it("gemini: cache is subset but reasoning is additive", () => {
    // cachedContentTokenCount ⊆ promptTokenCount, thoughtsTokenCount additive —
    // Google documents totalTokenCount = prompt + thoughts + candidates.
    expect(tokenSemantics("gemini", "generate_content")).toEqual([true, true, false]);
  });

  it("an OpenAI-shaped surface overrides the vendor", () => {
    // A provider="anthropic" ROW from Databricks' system table is in the gateway's
    // re-reported shape — everything subset — while the same vendor name from its own
    // API is additive. The surface wins.
    expect(tokenSemantics("anthropic", "databricks_gateway")).toEqual([true, true, true]);
    expect(OPENAI_SHAPED_APIS.has("databricks_gateway")).toBe(true);
  });

  it("an unknown provider defaults to additive", () => {
    // No overlap is removed for a name nobody measured: the conservative direction —
    // it can over-count a subset into a token total, but it can never silently drop
    // generated tokens or zero a real cache line.
    expect(tokenSemantics("some-new-gateway", "chat_completions")).toEqual([false, false, false]);
    expect(tokenSemantics("", "")).toEqual([false, false, false]);
  });
});
