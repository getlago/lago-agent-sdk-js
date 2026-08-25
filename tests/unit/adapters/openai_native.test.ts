/** OpenAI native adapter — verified against real fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractOpenAINative } from "../../../src/adapters/index.js";

const FIX = join(__dirname, "fixtures", "openai_native");

function load(name: string): { modelId: string; response: Record<string, unknown> } {
  const data = JSON.parse(readFileSync(join(FIX, name), "utf8"));
  return { modelId: data._model_id, response: data._response };
}

describe("OpenAI native adapter — Chat Completions fixtures", () => {
  it("plain chat completion", () => {
    const { modelId, response } = load("01_plain_chat.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.input).toBe(13);
    expect(u.output).toBe(23);
    expect(u.cache_read).toBe(0);
    expect(u.reasoning).toBe(0);
    expect(u.tool_calls).toBe(0);
    expect(u.audio_input).toBe(0);
    expect(u.audio_output).toBe(0);
    expect(u.api).toBe("chat_completions");
    expect(u.provider).toBe("openai");
  });

  it("tool use — counts choices[0].message.tool_calls", () => {
    const { modelId, response } = load("02_tool_use_chat.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.input).toBe(60);
    expect(u.output).toBe(5);
    expect(u.tool_calls).toBe(1);
  });

  it("first call — no cache hit yet", () => {
    const { modelId, response } = load("03_cache_call1_chat.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.input).toBe(3819);
    expect(u.cache_read).toBe(0);
  });

  it("second call — OpenAI auto-caches, exposes cached_tokens", () => {
    const { modelId, response } = load("04_cache_call2_chat.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.input).toBe(3819);
    expect(u.cache_read).toBe(3712);
    // OpenAI doesn't expose cache_write* fields
    expect(u.cache_write).toBe(0);
    expect(u.cache_write_5m).toBe(0);
    expect(u.cache_write_1h).toBe(0);
  });

  it("streaming chunk with usage — last chunk carries it when include_usage:true", () => {
    const { modelId, response } = load("05_streaming_chat.json");
    const chunks = (response.chunks as Array<Record<string, unknown>>) || [];
    const final = [...chunks].reverse().find((c) => c.usage);
    expect(final).toBeDefined();
    const u = extractOpenAINative(final!, modelId);
    expect(u.input).toBe(13);
    expect(u.output).toBe(29);
    expect(u.api).toBe("chat_completions");
  });

  it("reasoning model exposes reasoning_tokens (first provider to do so)", () => {
    const { modelId, response } = load("06_reasoning_chat.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.input).toBe(33);
    expect(u.output).toBe(1579);
    expect(u.reasoning).toBe(832); // real measured value
  });

  it("multi-turn", () => {
    const { modelId, response } = load("07_multi_turn_chat.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.input).toBe(34);
    expect(u.output).toBe(8);
  });
});

describe("OpenAI native adapter — Responses API fixtures", () => {
  it("plain responses", () => {
    const { modelId, response } = load("08_plain_responses.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.input).toBe(13);
    expect(u.output).toBe(19);
    expect(u.api).toBe("responses");
    expect(u.provider).toBe("openai");
  });

  it("tool use — counts output[].type == function_call", () => {
    const { modelId, response } = load("09_tool_use_responses.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.input).toBe(53);
    expect(u.output).toBe(6);
    expect(u.tool_calls).toBe(1);
  });

  it("reasoning via Responses API", () => {
    const { modelId, response } = load("10_reasoning_responses.json");
    const u = extractOpenAINative(response, modelId);
    expect(u.reasoning).toBe(320);
    expect(u.api).toBe("responses");
  });
});

describe("OpenAI native adapter — API detection", () => {
  it("prompt_tokens present → chat_completions", () => {
    const u = extractOpenAINative({ usage: { prompt_tokens: 1, completion_tokens: 1 } }, "x");
    expect(u.api).toBe("chat_completions");
  });

  it("input_tokens without prompt_tokens → responses", () => {
    const u = extractOpenAINative({ usage: { input_tokens: 1, output_tokens: 1 } }, "x");
    expect(u.api).toBe("responses");
  });
});

describe("OpenAI native adapter — model attribution (bill on what answered, not what was requested)", () => {
  it("resolves to the response's model, not the requested alias", () => {
    // Every non-streaming fixture in this suite shows this exact mismatch —
    // e.g. modelId="gpt-4o-mini" was requested, but the response reports
    // "gpt-4o-mini-2024-07-18". Pricing/attribution must key off what
    // actually answered, or every alias-based call gets billed under the
    // wrong model.
    const { modelId, response } = load("01_plain_chat.json");
    expect(modelId).toBe("gpt-4o-mini"); // sanity: the alias that was requested
    const u = extractOpenAINative(response, modelId);
    expect(u.model).toBe("gpt-4o-mini-2024-07-18"); // the resolved model that actually answered
  });

  it("falls back to the requested model when the response is silent about it", () => {
    // The synthetic usage blob the streaming wrapper builds carries no
    // top-level `model` — fall back to the requested model rather than
    // emitting an empty string.
    const u = extractOpenAINative({ usage: { prompt_tokens: 1, completion_tokens: 1 } }, "gpt-4o-mini");
    expect(u.model).toBe("gpt-4o-mini");
  });
});

describe("OpenAI native adapter — provider inference", () => {
  it("infers workers-ai from a Cloudflare @cf/ model string via the openai SDK shape", () => {
    // Real shape: the openai SDK pointed at Cloudflare's `.../compat`
    // endpoint, routed to a Workers AI model. The SDK shape looks identical
    // to a real OpenAI response — "provider" can only be told apart by the
    // resolved model string itself. Getting this wrong makes Workers AI
    // calls permanently unpriceable in price mode (stamped "openai", which
    // has no Workers AI entries in its price table).
    const resp = {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      usage: { prompt_tokens: 38, completion_tokens: 2 },
    };
    const u = extractOpenAINative(resp, "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(u.provider).toBe("workers-ai");
    expect(u.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("still infers openai for a real OpenAI model (no @cf/ prefix)", () => {
    const resp = { model: "gpt-4o-mini-2024-07-18", usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const u = extractOpenAINative(resp, "gpt-4o-mini");
    expect(u.provider).toBe("openai");
  });
});

describe("OpenAI native adapter — synthetic edge cases", () => {
  it("counts multiple tool_calls in chat completion", () => {
    const resp = {
      choices: [{ message: { tool_calls: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] } }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    };
    const u = extractOpenAINative(resp, "gpt-4o");
    expect(u.tool_calls).toBe(3);
  });

  it("counts multiple function_call items in Responses API output", () => {
    const resp = {
      output: [
        { type: "text" },
        { type: "function_call", name: "fn1" },
        { type: "function_call", name: "fn2" },
      ],
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const u = extractOpenAINative(resp, "gpt-4o");
    expect(u.tool_calls).toBe(2);
    expect(u.api).toBe("responses");
  });

  it("audio_input mapped from prompt_tokens_details.audio_tokens", () => {
    const resp = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { audio_tokens: 42, cached_tokens: 0 },
        completion_tokens_details: { audio_tokens: 0, reasoning_tokens: 0 },
      },
    };
    const u = extractOpenAINative(resp, "gpt-4o-audio");
    expect(u.audio_input).toBe(42);
    expect(u.audio_output).toBe(0);
  });

  it("audio_output mapped from completion_tokens_details.audio_tokens", () => {
    const resp = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { audio_tokens: 0, cached_tokens: 0 },
        completion_tokens_details: { audio_tokens: 33, reasoning_tokens: 0 },
      },
    };
    const u = extractOpenAINative(resp, "gpt-4o-audio");
    expect(u.audio_input).toBe(0);
    expect(u.audio_output).toBe(33);
  });

  it("unknown top-level usage field lands in extras (drift)", () => {
    const resp = {
      usage: { prompt_tokens: 5, completion_tokens: 7, future_field_xyz: "novel" },
    };
    const u = extractOpenAINative(resp, "gpt-4o");
    expect(u.extras.future_field_xyz).toBe("novel");
  });

  it("no usage returns all zeros", () => {
    const u = extractOpenAINative({}, "gpt-4o");
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
  });

  it("non-dict usage doesn't crash", () => {
    expect(extractOpenAINative({ usage: true }, "x").input).toBe(0);
    expect(extractOpenAINative({ usage: "bogus" }, "x").output).toBe(0);
    expect(extractOpenAINative(null, "x").input).toBe(0);
  });
});

describe("nested drift sweep + total_tokens consistency guard", () => {
  it("surfaces cache_write_tokens in extras but does NOT map it to cache_write", () => {
    // Real captured `gpt-5.6-sol` shape. Two assertions, and the second matters
    // most. The field must be SURFACED (it used to vanish entirely: extras swept
    // only top-level keys and prompt_tokens_details is itself a known top-level
    // key, so nothing nested was ever inspected). But it must NOT be mapped to
    // cache_write — for OpenAI these tokens sit INSIDE prompt_tokens and bill at
    // the plain input rate, while OpenRouter publishes a separate cache_write
    // rate, so mapping them would charge the same 3022 tokens twice ($0.0341
    // against a true $0.0152, 2.24x). Anthropic is the opposite case, which is
    // why mapping is right there.
    const resp = {
      model: "gpt-5.6-sol",
      usage: {
        prompt_tokens: 3025,
        completion_tokens: 4,
        total_tokens: 3029,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3022, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
      },
    };
    const u = extractOpenAINative(resp);
    expect(u.extras["prompt_tokens_details.cache_write_tokens"]).toBe(3022);
    expect(u.cache_write).toBe(0);
    expect(u.input).toBe(3025);
  });

  it("surfaces Predicted Outputs detail counts in extras", () => {
    // The module doc promised customers could read these from extras. They never
    // arrived, for the same nested-sweep reason. Now they do.
    const u = extractOpenAINative({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        completion_tokens_details: {
          reasoning_tokens: 0,
          accepted_prediction_tokens: 7,
          rejected_prediction_tokens: 3,
        },
      },
    });
    expect(u.extras["completion_tokens_details.accepted_prediction_tokens"]).toBe(7);
    expect(u.extras["completion_tokens_details.rejected_prediction_tokens"]).toBe(3);
  });

  it("recovers unaccounted output tokens from total_tokens", () => {
    // Measured against Gemini through Google's own OpenAI-compatible layer:
    // prompt=57, completion=47, total=1253. The 1149 thinking tokens are in
    // NEITHER named bucket and there is no completion_tokens_details to recover
    // them from — only total_tokens proves they exist. Billing prompt+completion
    // drops 92% of the call, at the output rate.
    //
    // The remainder folds into `output`, deliberately NOT into `reasoning`:
    // computeCost zeroes reasoning whenever provider is in
    // OUTPUT_INCLUDES_REASONING, and an OpenAI-shaped payload is stamped
    // provider="openai" by definition, so that would recover nothing.
    const u = extractOpenAINative({
      model: "gemini-2.5-flash",
      usage: { prompt_tokens: 57, completion_tokens: 47, total_tokens: 1253 },
    });
    expect(u.input).toBe(57);
    expect(u.output).toBe(1196);
    expect(u.extras.unaccounted_output_tokens).toBe(1149);
  });

  it("is a no-op for genuine OpenAI responses", () => {
    // For real OpenAI total_tokens == prompt + completion always holds, because
    // reasoning is a SUBSET of completion rather than additive. Verified across
    // every captured real response — zero deltas.
    const cases: Record<string, unknown>[] = [
      {
        prompt_tokens: 31,
        completion_tokens: 220,
        total_tokens: 251,
        completion_tokens_details: { reasoning_tokens: 220 },
      },
      {
        prompt_tokens: 3026,
        completion_tokens: 2,
        total_tokens: 3028,
        prompt_tokens_details: { cached_tokens: 2816 },
      },
      { prompt_tokens: 16, total_tokens: 16 }, // embeddings: no completion_tokens at all
    ];
    for (const usage of cases) {
      const u = extractOpenAINative({ usage });
      expect(u.output).toBe((usage.completion_tokens as number) ?? 0);
      expect(u.extras.unaccounted_output_tokens).toBeUndefined();
    }
  });

  it("ignores a negative delta", () => {
    // A total SMALLER than the parts is nonsense, not drift — never subtract.
    const u = extractOpenAINative({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 10 } });
    expect(u.output).toBe(50);
    expect(u.extras.unaccounted_output_tokens).toBeUndefined();
  });
});
