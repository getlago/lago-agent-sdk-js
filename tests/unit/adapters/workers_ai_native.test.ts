/** Workers AI `/ai/run` adapter — verified against real captured fixtures. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractWorkersAINative } from "../../../src/adapters/index.js";
import { nonzeroNumeric } from "../../../src/canonical.js";

const FIX = join(__dirname, "fixtures", "workers_ai");

function load(name: string): any {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}

function all(): string[] {
  try {
    return readdirSync(FIX)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

describe("Workers AI adapter — catalog models", () => {
  it("chat direct maps OpenAI-shaped usage", () => {
    const d = load("01_chat_direct.json");
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.input).toBe(41);
    expect(u.output).toBe(31);
    expect(u.cache_read).toBe(0);
    expect(u.reasoning).toBe(0);
    expect(u.provider).toBe("workers-ai");
    expect(u.api).toBe("workers_ai_run");
  });

  it("requested id is the billing key and the served name is kept", () => {
    // `...-3b-instruct` answers as `...-3b-instruct-v2`. The requested id is what the price
    // catalog is keyed by, so it is the one carried; the served name is not lost.
    const d = load("01_chat_direct.json");
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.model).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(u.extras.served_model).toBe("@cf/meta/llama-3.2-3b-instruct-v2");
  });

  it("a served name that would miss the catalog does not become the model", () => {
    // The case that decided the rule: Mistral small answers as `...-24b-v2` — `-instruct`
    // dropped, `-v2` added — and that name is NOT in Cloudflare's catalog (measured
    // 2026-09-21) while the requested id is.
    const d = load("04_mistral_small_direct.json");
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.model).toBe("@cf/mistralai/mistral-small-3.1-24b-instruct");
    expect(u.extras.served_model).toBe("@cf/mistralai/mistral-small-3.1-24b-v2");
    expect([u.input, u.output]).toEqual([10, 19]);
  });

  it("a served name equal to the requested one adds nothing to extras", () => {
    const d = load("03_gpt_oss_direct.json");
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.model).toBe("@cf/openai/gpt-oss-120b");
    expect("served_model" in u.extras).toBe(false);
    expect([u.input, u.output]).toEqual([73, 40]);
  });

  it("neurons land in extras, not in a metric", () => {
    const d = load("01_chat_direct.json");
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.extras.neurons).toBeCloseTo(1.1343257427215576, 12);
    expect("usage" in u.extras).toBe(false); // every other key was recognised — no drift reported
  });

  it("a reasoning model bundles thinking into completion", () => {
    // deepseek-r1-distill reasons but reports no separate field — do not invent one.
    const d = load("02_reasoning_direct.json");
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.input).toBe(13);
    expect(u.output).toBe(60);
    expect(u.reasoning).toBe(0);
  });

  it("a silent response keeps the requested model", () => {
    const d = load("02_reasoning_direct.json");
    expect(d._response.result.model).toBeUndefined();
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.model).toBe("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");
    expect("served_model" in u.extras).toBe(false);
  });

  it("gateway HIT and MISS bodies are identical", () => {
    // The gateway replays the cached body byte-for-byte, usage included. Nothing in the
    // body distinguishes a HIT — only the header does, which is why the client, not the
    // adapter, decides to skip billing.
    const miss = load("06_chat_gateway_miss.json");
    const hit = load("07_chat_gateway_hit.json");
    expect(miss._headers["cf-aig-cache-status"]).toBe("MISS");
    expect(hit._headers["cf-aig-cache-status"]).toBe("HIT");
    const um = extractWorkersAINative(miss._response, miss._model_id);
    const uh = extractWorkersAINative(hit._response, hit._model_id);
    expect([um.input, um.output]).toEqual([41, 39]);
    expect([uh.input, uh.output]).toEqual([41, 39]);
  });
});

describe("Workers AI adapter — partner model typesafe/jev", () => {
  it("via Cloudflare is wrapped one level deeper", () => {
    // `result: {state, result: {model, answers, usage}, gatewayMetadata}` — the partner's
    // own object sits under `result.result`. Captured through the unified `/ai/run` path
    // with `cf-aig-gateway-id` naming the gateway whose BYOK holds the TypeSafe key.
    const d = load("05_jev_byok_gateway.json");
    expect(d._response.result.state).toBe("Completed");
    expect("usage" in d._response.result.result).toBe(true);
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.input).toBe(446);
    expect(u.output).toBe(73);
    expect(u.cache_read).toBe(0);
    expect(u.reasoning).toBe(0);
    expect(u.provider).toBe("workers-ai");
    expect(u.api).toBe("workers_ai_run");
  });

  it("keeps its catalog id and reports the served version", () => {
    for (const name of ["05_jev_byok_gateway.json", "08_jev_typesafe_direct.json"]) {
      const d = load(name);
      const u = extractWorkersAINative(d._response, d._model_id);
      expect(u.model).toBe("typesafe/jev");
      expect(u.extras.served_model).toBe("jev-1.13.0");
    }
  });

  it("BYOK key source lands in extras", () => {
    // Under BYOK Cloudflare charged nothing — TypeSafe bills the customer directly. Whoever
    // reconciles against the Cloudflare dashboard needs to know which.
    const d = load("05_jev_byok_gateway.json");
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.extras.gateway_metadata).toEqual({ keySource: "BYOK" });
    expect("usage" in u.extras).toBe(false);
    expect("neurons" in u.extras).toBe(false);
  });

  it("from TypeSafe directly is the same object unwrapped", () => {
    const d = load("08_jev_typesafe_direct.json");
    expect(d._source).toContain("typesafe.ai");
    const u = extractWorkersAINative(d._response, d._model_id);
    expect([u.input, u.output]).toEqual([446, 73]);
    expect(Object.keys(u.extras)).toEqual(["served_model"]);
  });
});

describe.skipIf(all().length === 0)("Workers AI adapter — every capture", () => {
  it.each(all())("%s is a success that bills", (file) => {
    const d = load(file);
    expect(d._status).toBe(200); // only successful responses are kept as fixtures
    const u = extractWorkersAINative(d._response, d._model_id);
    expect(u.provider).toBe("workers-ai");
    expect(u.input).toBeGreaterThan(0);
    expect(u.output).toBeGreaterThan(0);
  });
});

describe("Workers AI adapter — failure envelope", () => {
  it("yields zero usage without throwing", () => {
    // The shape Cloudflare returns on 402/403/400 (seen live: `result: {}` + `errors`). The
    // client throws before billing; the adapter must still be safe to call on it.
    const body = { errors: [{ message: "Insufficient balance", code: 2021 }], success: false, result: {} };
    const u = extractWorkersAINative(body, "typesafe/jev");
    expect(Object.keys(nonzeroNumeric(u))).toEqual([]);
    expect(u.model).toBe("typesafe/jev");
  });
});
