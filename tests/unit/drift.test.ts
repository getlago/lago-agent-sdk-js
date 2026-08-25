/** Drift detection — unknown fields land in extras, not in numeric counts. */
import { describe, expect, it } from "vitest";

import {
  extractAnthropicNative,
  extractBedrockConverse,
  extractBedrockInvoke,
  extractOpenAINative,
} from "../../src/adapters/index.js";
import { nonzeroNumeric } from "../../src/canonical.js";
import { extractDatabricksLog } from "../../src/gateway/adapters/index.js";

describe("Drift detection — Converse", () => {
  it("unknown top-level usage field goes to extras", () => {
    const resp = { usage: { inputTokens: 10, outputTokens: 20, futureCacheReadAtL1Tokens: 99 } };
    const u = extractBedrockConverse(resp, "eu.something.future");
    expect(u.input).toBe(10);
    expect(u.output).toBe(20);
    expect(u.extras.futureCacheReadAtL1Tokens).toBe(99);
  });

  it("known aliases do not pollute extras", () => {
    const resp = {
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheReadInputTokenCount: 5,
        cacheWriteInputTokenCount: 0,
        totalTokens: 30,
        serverToolUsage: {},
      },
    };
    const u = extractBedrockConverse(resp, "eu.anthropic.claude-sonnet-4-6");
    expect(u.cache_read).toBe(5);
    expect("cacheReadInputTokenCount" in u.extras).toBe(false);
    expect("cacheWriteInputTokenCount" in u.extras).toBe(false);
    expect("totalTokens" in u.extras).toBe(false);
  });
});

describe("Drift detection — Invoke", () => {
  it("anthropic — unknown top usage field lands in extras", () => {
    const resp = {
      usage: { input_tokens: 13, output_tokens: 39, newSpecialField: "spectacular" },
      content: [],
    };
    const u = extractBedrockInvoke(resp, "eu.anthropic.claude-sonnet-4-6");
    expect(u.extras.newSpecialField).toBe("spectacular");
  });

  it("opus_4_7 — service_tier in extras", () => {
    const resp = {
      usage: { input_tokens: 5, output_tokens: 7, service_tier: "priority" },
      content: [],
    };
    const u = extractBedrockInvoke(resp, "eu.anthropic.claude-opus-4-7");
    expect(u.extras.service_tier).toBe("priority");
  });

  it("openai_compat — prompt_tokens_details lands in extras (drift signal)", () => {
    const resp = {
      usage: {
        prompt_tokens: 73,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 48 },
      },
    };
    const u = extractBedrockInvoke(resp, "openai.gpt-oss-safeguard-20b-1:0");
    expect(u.extras.prompt_tokens_details).toEqual({ cached_tokens: 48 });
  });
});

describe("Drift detection — native OpenAI, ONE LEVEL DOWN", () => {
  it("nested detail drift reaches extras", () => {
    // The drift contract has to hold inside the *_tokens_details sub-objects, not
    // just at the top level. This is the hole a live `gpt-5.6-sol` response found:
    // it reports prompt_tokens_details.cache_write_tokens: 3022, and because
    // prompt_tokens_details is itself a KNOWN top-level key the old sweep never
    // looked inside it. 3022 real tokens were discarded with no error and no
    // onError — the exact failure this file exists to prevent. Every drift test
    // passed, because none of them looked one level down.
    const u = extractOpenAINative({
      usage: {
        prompt_tokens: 3025,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3022 },
        completion_tokens_details: { reasoning_tokens: 0, future_nested_xyz: 42 },
      },
    });
    expect(u.extras["prompt_tokens_details.cache_write_tokens"]).toBe(3022);
    expect(u.extras["completion_tokens_details.future_nested_xyz"]).toBe(42);
  });

  it("mapped nested fields do not pollute extras", () => {
    // The mirror of the above: a nested key we DO map must not also appear in
    // extras, or every event carries a duplicate of a value already billed.
    const u = extractOpenAINative({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 40, audio_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 20, audio_tokens: 3 },
      },
    });
    expect(u.cache_read).toBe(40);
    expect(u.reasoning).toBe(20);
    expect(u.audio_input).toBe(5);
    expect(u.audio_output).toBe(3);
    for (const k of Object.keys(u.extras)) {
      expect(k.endsWith(".cached_tokens")).toBe(false);
      expect(k.endsWith(".reasoning_tokens")).toBe(false);
      expect(k.endsWith(".audio_tokens")).toBe(false);
    }
  });

  it("Responses-API shape gets the same guarantee", () => {
    // Its detail containers are named differently.
    const u = extractOpenAINative({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 2, novel_input_detail: "x" },
        output_tokens_details: { reasoning_tokens: 1, novel_output_detail: "y" },
      },
    });
    expect(u.api).toBe("responses");
    expect(u.extras["input_tokens_details.novel_input_detail"]).toBe("x");
    expect(u.extras["output_tokens_details.novel_output_detail"]).toBe("y");
  });
});

describe("Drift detection — fields first seen through the Databricks gateway", () => {
  it("Anthropic service_tier and inference_geo reach extras", () => {
    // Two fields that appeared on live Anthropic responses through the Databricks
    // gateway and are in no fixture predating it: service_tier ("standard") and
    // inference_geo ("global" for sonnet-4-6, "not_available" for the others).
    // Neither is a token count, so both must land in extras — never miscounted as a
    // metric, never silently dropped.
    const u = extractAnthropicNative({
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: "standard",
        inference_geo: "global",
      },
    });
    expect(u.input).toBe(8);
    expect(u.output).toBe(4);
    expect(u.extras.service_tier).toBe("standard");
    expect(u.extras.inference_geo).toBe("global");
    expect(nonzeroNumeric(u)).toEqual({ input: 8, output: 4 });
  });
});

describe("openai native — post-review drift holes", () => {
  it("lets Responses audio_tokens reach extras, because nothing maps them", () => {
    // `output_tokens_details.audio_tokens` was listed as a MAPPED nested key, so it was
    // excluded from extras — while the Responses branch hardcodes `audioOutput = 0`
    // because the API doesn't expose it. Both true at once means the count is neither
    // billed nor surfaced: 500 real tokens gone with no error.
    const u = extractOpenAINative({
      usage: {
        input_tokens: 10,
        output_tokens: 500,
        output_tokens_details: { reasoning_tokens: 0, audio_tokens: 500 },
      },
    });
    expect(u.api).toBe("responses");
    expect(u.audio_output).toBe(0);
    expect(u.extras["output_tokens_details.audio_tokens"]).toBe(500);
  });

  it("does not double-bill additive reasoning via the total_tokens guard", () => {
    // The guard folds an unexplained delta into `output`. For a provider whose reasoning
    // is ADDITIVE (this adapter now stamps `databricks` and `workers-ai`, not only
    // `openai`), a payload reporting BOTH reasoning_tokens and an inflated total would be
    // charged twice — inside the grown output and again as a reasoning line.
    const u = extractOpenAINative(
      {
        usage: {
          prompt_tokens: 57,
          completion_tokens: 47,
          total_tokens: 1253,
          completion_tokens_details: { reasoning_tokens: 1149 },
        },
      },
      "",
      "databricks",
    );
    expect(u.reasoning).toBe(1149);
    expect(u.output).toBe(47);
    expect(u.extras.unaccounted_output_tokens).toBeUndefined();
  });

  it("still recovers tokens nobody broke out", () => {
    // The case the guard was written for, measured live: prompt 57, completion 47,
    // total 1253, no completion_tokens_details to recover the 1,149 from.
    const u = extractOpenAINative({
      usage: { prompt_tokens: 57, completion_tokens: 47, total_tokens: 1253 },
    });
    expect(u.output).toBe(47 + 1149);
    expect(u.extras.unaccounted_output_tokens).toBe(1149);
  });
});

describe("Drift detection — Databricks gateway, inside `token_details`", () => {
  it("token_details drift reaches extras", () => {
    // `token_details` is a STRUCT read by name, so an added field is invisible.
    // Measured against the live table with the struct evolved by two fields: 119 real
    // tokens reached neither a numeric field nor `extras`. The column is the one place
    // this table publishes per-token-kind counts, so drift there is money-relevant by
    // construction — a new cache tier or modality lands nowhere else.
    const row = {
      destination_type: "EXTERNAL_FOUNDATION_MODEL",
      api_type: "anthropic/v1/messages",
      destination_model: "claude-sonnet-4-5",
      input_tokens: 1825,
      output_tokens: 4,
      token_details: {
        cache_read_input_tokens: 1812,
        cache_read_5m_input_tokens: 77,
        output_audio_tokens: 42,
      },
    };
    const u = extractDatabricksLog(row);
    expect(u.extras["token_details.cache_read_5m_input_tokens"]).toBe(77);
    expect(u.extras["token_details.output_audio_tokens"]).toBe(42);
    // Never MISCOUNTED as a metric we do map — that would bill an unclassified count
    // at a rate nobody chose for it.
    expect([u.cache_read, u.cache_write, u.reasoning]).toEqual([1812, 0, 0]);
  });

  it("mapped token_details do not pollute extras", () => {
    // The mirror: a nested key we DO map must not also appear in extras, or every
    // event carries a duplicate of a count already billed.
    const u = extractDatabricksLog({
      destination_type: "EXTERNAL_FOUNDATION_MODEL",
      api_type: "openai/v1/chat/completions",
      destination_model: "gpt-4o",
      input_tokens: 100,
      output_tokens: 50,
      token_details: {
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 0,
        output_reasoning_tokens: 20,
      },
    });
    expect(u.cache_read).toBe(40);
    expect(u.reasoning).toBe(20);
    expect(Object.keys(u.extras).filter((k) => k.startsWith("token_details."))).toEqual([]);
  });

  it("token_details drift survives the JSON-string path", () => {
    // Schema evolution arrives over the REST path as a longer JSON STRING, which is how
    // `DatabricksSource.query` reads every STRUCT column — measured on the live
    // warehouse, `token_details` is a string there, never an object. A sweep that only
    // worked on driver-native objects would miss the exact path the backfill uses.
    const u = extractDatabricksLog({
      destination_type: "PAY_PER_TOKEN_FOUNDATION_MODEL",
      destination_name: "system.ai.gpt-oss-20b",
      input_tokens: "300",
      output_tokens: "12",
      token_details: '{"output_reasoning_tokens":"9","output_audio_tokens":"42"}',
    });
    expect(u.reasoning).toBe(9);
    expect(u.extras["token_details.output_audio_tokens"]).toBe("42");
  });
});
