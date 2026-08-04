/** Gemini native adapter — verified against real fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractGeminiNative } from "../../../src/adapters/index.js";

const FIX = join(__dirname, "fixtures", "gemini_native");

function load(name: string): { modelId: string; response: Record<string, unknown> } {
  const data = JSON.parse(readFileSync(join(FIX, name), "utf8"));
  return { modelId: data._model_id, response: data._response };
}

describe("Gemini native adapter — fixtures", () => {
  it("plain flash", () => {
    const { modelId, response } = load("01_plain_flash.json");
    const u = extractGeminiNative(response, modelId);
    expect(u.input).toBe(7);
    expect(u.output).toBe(23);
    expect(u.reasoning).toBe(442); // gemini-2.5 emits thoughts by default
    expect(u.tool_calls).toBe(0);
    expect(u.api).toBe("native");
    expect(u.provider).toBe("gemini");
  });

  it("tool use — counts function_call in candidates[0].content.parts", () => {
    const { modelId, response } = load("02_tool_use.json");
    const u = extractGeminiNative(response, modelId);
    expect(u.input).toBe(49);
    expect(u.output).toBe(15);
    expect(u.tool_calls).toBe(1);
  });

  it("streaming — usage on the final chunk", () => {
    const { modelId, response } = load("03_streaming.json");
    const chunks = (response.chunks as Array<Record<string, unknown>>) || [];
    const final = [...chunks].reverse().find((c) => c.usage_metadata);
    expect(final).toBeDefined();
    const u = extractGeminiNative(final!, modelId);
    expect(u.input).toBe(14);
    expect(u.output).toBe(9);
    expect(u.reasoning).toBe(29);
  });

  it("thinking mode populates reasoning (additive to output)", () => {
    const { modelId, response } = load("04_thinking.json");
    const u = extractGeminiNative(response, modelId);
    expect(u.input).toBe(27);
    expect(u.output).toBe(1003);
    expect(u.reasoning).toBe(1546);
    // Math: input + output + reasoning = total. Confirms additive semantics.
    expect(u.input + u.output + u.reasoning).toBe(2576);
  });

  it("multi-turn", () => {
    const { modelId, response } = load("05_multi_turn.json");
    const u = extractGeminiNative(response, modelId);
    expect(u.input).toBe(22);
    expect(u.output).toBe(25);
  });
});

describe("Gemini native adapter — synthetic edges", () => {
  it("audio_input from prompt_tokens_details[modality=AUDIO]", () => {
    const resp = {
      usage_metadata: {
        prompt_token_count: 1000,
        candidates_token_count: 50,
        prompt_tokens_details: [
          { modality: "TEXT", token_count: 200 },
          { modality: "AUDIO", token_count: 800 },
        ],
      },
    };
    const u = extractGeminiNative(resp, "gemini-2.5-flash");
    expect(u.input).toBe(1000);
    expect(u.audio_input).toBe(800);
    expect(u.image_input).toBe(0);
  });

  it("image_input from prompt_tokens_details[modality=IMAGE]", () => {
    const resp = {
      usage_metadata: {
        prompt_token_count: 500,
        candidates_token_count: 50,
        prompt_tokens_details: [
          { modality: "TEXT", token_count: 300 },
          { modality: "IMAGE", token_count: 200 },
        ],
      },
    };
    const u = extractGeminiNative(resp, "gemini-2.5-flash");
    expect(u.image_input).toBe(200);
  });

  it("audio_output from candidates_tokens_details[modality=AUDIO]", () => {
    const resp = {
      usage_metadata: {
        prompt_token_count: 50,
        candidates_token_count: 1500,
        candidates_tokens_details: [{ modality: "AUDIO", token_count: 1500 }],
      },
    };
    const u = extractGeminiNative(resp, "gemini-2.5-flash-audio");
    expect(u.audio_output).toBe(1500);
  });

  it("cached_content_token_count → cache_read", () => {
    const resp = {
      usage_metadata: {
        prompt_token_count: 5000,
        candidates_token_count: 30,
        cached_content_token_count: 4800,
      },
    };
    const u = extractGeminiNative(resp, "gemini-2.5-flash");
    expect(u.cache_read).toBe(4800);
  });

  it("counts multiple function_calls", () => {
    const resp = {
      usage_metadata: { prompt_token_count: 10, candidates_token_count: 20 },
      candidates: [
        {
          content: {
            parts: [
              { text: "..." },
              { function_call: { name: "fn1" } },
              { function_call: { name: "fn2" } },
              { function_call: { name: "fn3" } },
            ],
          },
        },
      ],
    };
    const u = extractGeminiNative(resp, "gemini-2.5-flash");
    expect(u.tool_calls).toBe(3);
  });

  it("handles camelCase wire format (from @google/genai SDK pydantic-like objects)", () => {
    const resp = {
      candidates: [{ content: { parts: [{ functionCall: { name: "fn" } }] } }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 3,
        cachedContentTokenCount: 0,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 4 },
          { modality: "AUDIO", tokenCount: 1 },
        ],
      },
    };
    const u = extractGeminiNative(resp, "gemini-2.5-flash");
    expect(u.input).toBe(5);
    expect(u.output).toBe(10);
    expect(u.reasoning).toBe(3);
    expect(u.audio_input).toBe(1);
    expect(u.tool_calls).toBe(1);
  });

  it("unknown usage field lands in extras (drift)", () => {
    const resp = {
      usage_metadata: {
        prompt_token_count: 10,
        candidates_token_count: 20,
        future_field_xyz: "novel",
      },
    };
    const u = extractGeminiNative(resp, "gemini-2.5-flash");
    expect(u.extras.future_field_xyz).toBe("novel");
  });

  it("no usage returns zeros", () => {
    const u = extractGeminiNative({}, "gemini-2.5-flash");
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
  });

  it("survives non-dict usage_metadata", () => {
    expect(extractGeminiNative({ usage_metadata: true }, "x").input).toBe(0);
    expect(extractGeminiNative({ usage_metadata: "bogus" }, "x").output).toBe(0);
    expect(extractGeminiNative(null, "x").input).toBe(0);
  });
});
