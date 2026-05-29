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
