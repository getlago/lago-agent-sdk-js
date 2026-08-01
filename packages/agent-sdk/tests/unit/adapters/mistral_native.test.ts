/** Mistral native adapter — verified against real fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractMistralNative } from "../../../src/adapters/index.js";

const FIX = join(__dirname, "fixtures", "mistral_native");

function load(name: string): { modelId: string; response: any } {
  const data = JSON.parse(readFileSync(join(FIX, name), "utf8"));
  return { modelId: data._model_id, response: data._response };
}

describe("Mistral native adapter — fixtures", () => {
  it("plain small", () => {
    const { modelId, response } = load("01_plain_small.json");
    const u = extractMistralNative(response, modelId);
    expect(u.input).toBe(22);
    expect(u.output).toBe(19);
    expect(u.cache_read).toBe(0);
    expect(u.tool_calls).toBe(0);
    expect(u.api).toBe("native");
    expect(u.provider).toBe("mistral");
  });

  it("plain large", () => {
    const { modelId, response } = load("02_plain_large.json");
    const u = extractMistralNative(response, modelId);
    expect(u.input).toBe(10);
    expect(u.output).toBe(19);
  });

  it("tool use — counts message.tool_calls", () => {
    const { modelId, response } = load("03_tool_use.json");
    const u = extractMistralNative(response, modelId);
    expect(u.tool_calls).toBe(1);
    expect(u.input).toBe(83);
  });

  it("magistral reasoning bundles into completion (no separate count)", () => {
    const { modelId, response } = load("04_reasoning_magistral.json");
    const u = extractMistralNative(response, modelId);
    expect(u.input).toBe(54);
    expect(u.output).toBe(600);
    expect(u.reasoning).toBe(0);
  });

  it("multi-turn", () => {
    const { modelId, response } = load("06_multi_turn.json");
    const u = extractMistralNative(response, modelId);
    expect(u.input).toBe(37);
    expect(u.output).toBe(18);
  });
});

describe("Mistral native adapter — synthetic", () => {
  it("cache_read populates from prompt_tokens_details.cached_tokens", () => {
    const resp = {
      model: "mistral-large-latest",
      choices: [{ message: { content: "hi", tool_calls: null } }],
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 5,
        total_tokens: 1505,
        prompt_tokens_details: { cached_tokens: 1200 },
      },
    };
    const u = extractMistralNative(resp, "mistral-large-latest");
    expect(u.cache_read).toBe(1200);
  });

  it("counts multiple tool_calls", () => {
    const resp = {
      model: "x",
      choices: [{ message: { tool_calls: [{ id: "a" }, { id: "b" }, { id: "c" }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    expect(extractMistralNative(resp, "x").tool_calls).toBe(3);
  });

  it("unknown usage field lands in extras", () => {
    const resp = {
      choices: [{ message: {} }],
      usage: { prompt_tokens: 1, completion_tokens: 2, novel_field: 99 },
    };
    expect(extractMistralNative(resp, "x").extras.novel_field).toBe(99);
  });

  it("empty input returns zeros", () => {
    expect(extractMistralNative({}).input).toBe(0);
    expect(extractMistralNative(null as any).output).toBe(0);
  });
});
