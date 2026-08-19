import { describe, it, expect } from "vitest";
import { providerHintFor } from "../../src/wrappers/openai.js";
import { extractOpenAINative } from "../../src/adapters/openai_native.js";
import { RAMP_ROUTER_PROVIDER } from "../../src/ramp_router_ids.js";

/**
 * Ramp Router live-path detection.
 *
 * Everything here is derived from documented behavior (docs.router.com/api/endpoint:
 * base URL `https://api.router.com/v1`, Responses-only surface). The questions that
 * need a live key — what the response `model` reports under a `models` fallback, and
 * whether Router's `input_tokens` includes cached tokens — are covered by
 * tests/integration/live_ramp_router.test.ts, not asserted here.
 */

describe("providerHintFor — Ramp Router detection by baseURL", () => {
  const hint = (baseURL: unknown) => providerHintFor({ baseURL });

  it("recognizes the documented base URL", () => {
    expect(hint("https://api.router.com/v1")).toBe(RAMP_ROUTER_PROVIDER);
  });

  it.each([
    "https://api.router.com/v1",
    "https://api.router.com/v1/",
    "https://api.router.com",
    "https://API.ROUTER.COM/v1",
    "https://api.router.com:443/v1",
  ])("recognizes %s", (url) => {
    expect(hint(url)).toBe(RAMP_ROUTER_PROVIDER);
  });

  it("matches the hostname, not the string anywhere in the URL", () => {
    // A substring match would stamp these as Router and price them against Router's
    // catalog — a wrong price, not a miss.
    expect(hint("https://example.com/proxy?upstream=api.router.com")).toBe("");
    expect(hint("https://api.router.com.evil.example/v1")).toBe("");
    expect(hint("https://notapi.router.com.example/v1")).toBe("");
  });

  it("leaves a direct OpenAI client alone", () => {
    expect(hint("https://api.openai.com/v1")).toBe("");
    expect(hint(undefined)).toBe("");
    expect(hint("")).toBe("");
  });

  it("still recognizes the Databricks hosted path — the pre-existing arm is unchanged", () => {
    expect(hint("https://dbc-x.cloud.databricks.com/ai-gateway/mlflow/v1")).toBe("databricks");
  });

  it("prefers Databricks when a URL could somehow match both", () => {
    // Order is deterministic rather than accidental: the path arm is checked first.
    expect(hint("https://api.router.com/ai-gateway/mlflow/v1")).toBe("databricks");
  });

  it.each([null, 42, {}, [], { baseURL: {} }])("degrades to no hint on the malformed client %o", (client) => {
    expect(providerHintFor(client)).toBe("");
  });

  it("never throws when baseURL access itself throws", () => {
    const hostile = {
      get baseURL(): string {
        throw new Error("boom");
      },
    };
    expect(() => providerHintFor(hostile)).not.toThrow();
    expect(providerHintFor(hostile)).toBe("");
  });
});

describe("extractOpenAINative — a hinted Router call is stamped as Router", () => {
  // Shape from docs.router.com: an OpenAI Responses payload. Token counts are
  // arbitrary here; the real captured counts live in the fixtures.
  const routerResponse = {
    model: "opus-5",
    usage: {
      input_tokens: 120,
      output_tokens: 16,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };

  it("sets both provider and api to ramp_router", () => {
    const u = extractOpenAINative(routerResponse, "opus-5", RAMP_ROUTER_PROVIDER);
    expect(u.provider).toBe(RAMP_ROUTER_PROVIDER);
    expect(u.api).toBe(RAMP_ROUTER_PROVIDER);
  });

  it("extracts the token counts unchanged — Router speaks the Responses shape", () => {
    const u = extractOpenAINative(routerResponse, "opus-5", RAMP_ROUTER_PROVIDER);
    expect(u.input).toBe(120);
    expect(u.output).toBe(16);
  });

  it("prefers the model the response reports over the requested one", () => {
    // Load-bearing for `models` fallback: the served candidate is the only correct
    // thing to bill. Whether Router actually reports it is measured live.
    const u = extractOpenAINative(
      { ...routerResponse, model: "openai:gpt-5.4-mini" },
      "anthropic:opus-5",
      RAMP_ROUTER_PROVIDER,
    );
    expect(u.model).toBe("openai:gpt-5.4-mini");
  });

  it("leaves api as the request surface when there is no Router hint", () => {
    const u = extractOpenAINative(routerResponse, "gpt-5");
    expect(u.api).toBe("responses");
    expect(u.provider).toBe("openai");
  });

  it("does not stamp Router from a model string alone", () => {
    // Only the wrapper knows the baseURL. A model id that looks Router-shaped must not
    // be enough, or a direct OpenAI call could be priced against Router's catalog.
    const u = extractOpenAINative({ ...routerResponse, model: "openai:gpt-5.4-mini" }, "");
    expect(u.provider).not.toBe(RAMP_ROUTER_PROVIDER);
    expect(u.api).toBe("responses");
  });

  it("emits nothing for a zero-usage Router response", () => {
    const u = extractOpenAINative(
      { model: "opus-5", usage: { input_tokens: 0, output_tokens: 0 } },
      "opus-5",
      RAMP_ROUTER_PROVIDER,
    );
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
  });

  it.each([{}, { usage: null }, { usage: "nope" }, { model: 42, usage: {} }])(
    "degrades to zeros on the malformed Router payload %o",
    (payload) => {
      expect(() => extractOpenAINative(payload, "", RAMP_ROUTER_PROVIDER)).not.toThrow();
      const u = extractOpenAINative(payload, "", RAMP_ROUTER_PROVIDER);
      expect(u.input).toBe(0);
      expect(u.output).toBe(0);
    },
  );
});
