import { describe, it, expect } from "vitest";
import {
  parseRouterModelId,
  normalizeRouterProvider,
  ROUTER_SERVICE_TIERS,
  ROUTER_PROVIDER_ALIASES,
} from "../../src/ramp_router_ids.js";

describe("parseRouterModelId — the two documented selector forms", () => {
  it("reads a plain provider:model candidate", () => {
    expect(parseRouterModelId("openai:gpt-5.4-mini")).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      tier: "",
    });
  });

  it("leaves the provider empty for a bare `model` id, rather than guessing a vendor", () => {
    // Router's /v1/models ids carry no vendor ("opus-5", "gpt-5.4"). Inventing one is
    // how a call gets priced against a rate card that never quoted it.
    for (const bare of ["opus-5", "gpt-5.4", "deepseek-v4-flash"]) {
      expect(parseRouterModelId(bare)).toEqual({ provider: "", model: bare, tier: "" });
    }
  });

  it("keeps slashes in the model part, splitting on the FIRST colon only", () => {
    // The real documented Fireworks form. Splitting on the last colon would yield
    // provider="fireworks:accounts/fireworks/models" — a guaranteed price miss.
    expect(parseRouterModelId("fireworks:accounts/fireworks/models/deepseek-v4-flash")).toEqual({
      provider: "fireworks",
      model: "accounts/fireworks/models/deepseek-v4-flash",
      tier: "",
    });
  });

  it("pulls a service tier off the third segment", () => {
    expect(parseRouterModelId("openai:gpt-5-mini:flex")).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      tier: "flex",
    });
  });

  it("handles a tier on a slash-bearing model id — both traps at once", () => {
    expect(parseRouterModelId("fireworks:accounts/fireworks/models/kimi-k2p7-code:priority")).toEqual({
      provider: "fireworks",
      model: "accounts/fireworks/models/kimi-k2p7-code",
      tier: "priority",
    });
  });

  it.each([...ROUTER_SERVICE_TIERS])("recognizes the documented tier %s", (tier) => {
    expect(parseRouterModelId(`openai:gpt-5-mini:${tier}`)).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      tier,
    });
  });

  it("does NOT treat an unknown trailing segment as a tier", () => {
    // The closed vocabulary is what makes the third segment safe to detect. A model id
    // that merely contains a colon must not be silently truncated: a mis-split provider
    // mis-prices, where an unparsed model id only misses.
    expect(parseRouterModelId("openai:some-model:v2")).toEqual({
      provider: "openai",
      model: "some-model:v2",
      tier: "",
    });
    expect(parseRouterModelId("anthropic:opus-5:turbo")).toEqual({
      provider: "anthropic",
      model: "opus-5:turbo",
      tier: "",
    });
  });

  it("lowercases provider and tier but preserves model case", () => {
    expect(parseRouterModelId("OpenAI:GPT-5-Mini:FLEX")).toEqual({
      provider: "openai",
      model: "GPT-5-Mini",
      tier: "flex",
    });
  });
});

describe("parseRouterModelId — degrades instead of throwing", () => {
  it.each([
    [undefined, { provider: "", model: "", tier: "" }],
    [null, { provider: "", model: "", tier: "" }],
    ["", { provider: "", model: "", tier: "" }],
    ["   ", { provider: "", model: "", tier: "" }],
    [42, { provider: "", model: "", tier: "" }],
    [{}, { provider: "", model: "", tier: "" }],
    [[], { provider: "", model: "", tier: "" }],
  ])("maps %o to all-empty", (input, want) => {
    expect(parseRouterModelId(input)).toEqual(want);
  });

  it("reports the provider and an empty model for a dangling colon", () => {
    // Not an invented model. An empty model is a miss the caller can see.
    expect(parseRouterModelId("openai:")).toEqual({ provider: "openai", model: "", tier: "" });
  });

  it("does not read a lone tier as a model", () => {
    // ":flex" has an empty provider segment and "flex" as the remainder. The tier arm
    // must not fire on a suffix that is the whole string.
    expect(parseRouterModelId(":flex")).toEqual({ provider: "", model: "flex", tier: "" });
  });
});

describe("normalizeRouterProvider — only priceable vendors are mapped", () => {
  it.each([
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["mistral", "mistral"],
    ["gemini", "gemini"],
  ])("passes %s through as the SDK's own name", (input, want) => {
    expect(normalizeRouterProvider(input)).toBe(want);
  });

  it.each(["google", "google-vertex", "vertex"])(
    "maps %s to gemini, keeping two tables in agreement",
    (input) => {
      // Not cosmetic. VENDOR_MAP resolves "google" fine, but INPUT_INCLUDES_CACHE_READ is
      // keyed on "gemini" alone, and Gemini's cache_read is a SUBSET of its input count.
      // Left as "google" the cached portion is billed twice — the exact bug the Cloudflare
      // connector shipped first.
      expect(normalizeRouterProvider(input)).toBe("gemini");
    },
  );

  it.each(["fireworks", "deepseek", "xai", "nvidia", "kimi", "glm", "minimax", "qwen"])(
    "leaves %s unmapped so the price miss is honest",
    (input) => {
      // Router serves these; this SDK holds no rate for them under that name. A miss
      // falls back to token events. A mapping would bill at a rate nobody quoted.
      expect(normalizeRouterProvider(input)).toBe(input);
      expect(ROUTER_PROVIDER_ALIASES[input]).toBeUndefined();
    },
  );

  it("lowercases before matching", () => {
    expect(normalizeRouterProvider("OpenAI")).toBe("openai");
    expect(normalizeRouterProvider("GOOGLE")).toBe("gemini");
  });

  it.each([undefined, null, 42, {}, []])("maps the non-string %o to an empty provider", (input) => {
    expect(normalizeRouterProvider(input)).toBe("");
  });
});
