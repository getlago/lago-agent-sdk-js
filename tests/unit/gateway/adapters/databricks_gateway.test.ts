/**
 * Databricks AI Gateway usage adapter — verified against real captured table rows.
 *
 * Fixtures were read from a live workspace's `system.ai_gateway.usage` over the SQL
 * Statement Execution API, one file per scenario. Identity-bearing fields are replaced
 * with deterministic, visibly synthetic values; billing-relevant fields remain captured.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractDatabricksLog,
  resolveDatabricksSubscription,
} from "../../../../src/gateway/adapters/index.js";
import { lookupOpenRouter, parseOpenRouter } from "../../../../src/pricing.js";
import { NUMERIC_FIELDS, nonzeroNumeric } from "../../../../src/canonical.js";

const FIX = join(__dirname, "fixtures", "databricks_gateway");
const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, name), "utf8"));

describe("Databricks gateway — real fixtures, the two destination types", () => {
  it("hosted chat row", () => {
    const u = extractDatabricksLog(load("hosted_chat.json"));
    expect(u.input).toBe(11);
    expect(u.output).toBe(4);
    expect(u.model).toBe("llama-4-maverick");
    expect(u.provider).toBe("databricks");
    expect(u.api).toBe("databricks_gateway");
  });

  it("hosted embeddings row — output_tokens is NULL, not 0", () => {
    const u = extractDatabricksLog(load("hosted_embeddings.json"));
    expect(u.input).toBe(13);
    expect(u.output).toBe(0);
    expect(u.provider).toBe("databricks");
    expect(u.extras.api_type).toBe("mlflow/v1/embeddings");
  });

  it("BYOK anthropic row", () => {
    const u = extractDatabricksLog(load("byok_anthropic_cache_read.json"));
    expect(u.model).toBe("claude-sonnet-4-5");
    expect(u.provider).toBe("anthropic");
    expect(u.extras.destination_type).toBe("EXTERNAL_FOUNDATION_MODEL");
  });

  it("BYOK openai reasoning row — the table DOES break out reasoning", () => {
    // Even though the mlflow response body reports none at all: the live and
    // backfill paths genuinely disagree on this field.
    const u = extractDatabricksLog(load("byok_openai_reasoning.json"));
    expect(u.provider).toBe("openai");
    expect(u.reasoning).toBe(220);
    expect(u.output).toBe(220);
  });
});

describe("Databricks gateway — the two naming quirks a docs-only reading gets wrong", () => {
  it("hosted model comes from destination_name, not destination_model", () => {
    // For hosted rows destination_model is unstable — the same destination_name was
    // observed reporting both `llama-4-maverick` and the display label
    // `Llama 4 Maverick`. destination_name is the stable id, prefix stripped.
    const u = extractDatabricksLog({
      destination_type: "PAY_PER_TOKEN_FOUNDATION_MODEL",
      destination_name: "system.ai.gpt-oss-20b",
      destination_model: "GPT OSS 20B", // display label, spaces and capitals
      api_type: "mlflow/v1/chat/completions",
      input_tokens: "102",
      output_tokens: "4",
    });
    expect(u.model).toBe("gpt-oss-20b");
    expect(u.provider).toBe("databricks");
  });

  it("hosted destination_name sheds its endpoint prefix", () => {
    // Most hosted entities are named `system.ai.databricks-<model>`, not
    // `system.ai.<model>` — measured on a live workspace, 38 of 48 distinct hosted
    // destination_names carry that inner `databricks-`. It is a serving-endpoint
    // artefact, not part of the model id: leaving it in emits
    // `databricks-qwen35-122b-a10b`, which both reads as a vendor prefix and splits
    // one model into two rows in Lago against the live path's own name.
    // Real captured row, not hand-written.
    const u = extractDatabricksLog(load("hosted_chat_endpoint_prefixed_name.json"));
    expect(u.model).toBe("qwen35-122b-a10b");
    expect(u.provider).toBe("databricks");
    expect(u.input).toBe(37);
    expect(u.output).toBe(200);
    // The raw name stays visible for reconciliation against Databricks' own console.
    expect(u.extras.destination_name).toBe("system.ai.databricks-qwen35-122b-a10b");
  });

  it("hosted prefix stripping does not rename a genuinely databricks model", () => {
    // Databricks publishes models whose own names start with `databricks-`
    // (`databricks-dbrx-instruct`, `databricks-dolly-v2`), so an unconditional strip
    // would rename them. destination_model is the tie-breaker: it agrees with the shed
    // form when the prefix is an endpoint artefact, and with the full name when the
    // model is really called that.
    const artefact = {
      destination_type: "PAY_PER_TOKEN_FOUNDATION_MODEL",
      destination_name: "system.ai.databricks-claude-sonnet-4-5",
      destination_model: "claude-sonnet-4-5",
      api_type: "mlflow/v1/chat/completions",
      input_tokens: "5",
      output_tokens: "5",
    };
    expect(extractDatabricksLog(artefact).model).toBe("claude-sonnet-4-5");

    expect(
      extractDatabricksLog({
        ...artefact,
        destination_name: "system.ai.databricks-dbrx-instruct",
        destination_model: "databricks-dbrx-instruct",
      }).model,
    ).toBe("databricks-dbrx-instruct");

    // Disagreement (the unstable display-label case) keeps the raw name rather than
    // guessing — an ugly id beats a wrong one.
    expect(extractDatabricksLog({ ...artefact, destination_model: "Claude Sonnet 4.5" }).model).toBe(
      "databricks-claude-sonnet-4-5",
    );
  });

  it("BYOK never uses destination_name as the model", () => {
    // For BYOK rows destination_name is the PROVIDER SERVICE — a Unity Catalog
    // credential name. Falling back to it would bill the credential as the model.
    const u = extractDatabricksLog({
      destination_type: "EXTERNAL_FOUNDATION_MODEL",
      destination_name: "workspace.default.anthropickey",
      destination_model: "claude-opus-4-5",
      api_type: "anthropic/v1/messages",
      input_tokens: "16",
      output_tokens: "47",
    });
    expect(u.model).toBe("claude-opus-4-5");
    expect(u.model).not.toContain("workspace.default");
    expect(u.extras.destination_name).toBe("workspace.default.anthropickey");
  });

  it("provider is derived from api_type's leading segment", () => {
    // api_type is the full ingress path, and its leading segment already IS this
    // SDK's provider vocabulary — so no alias table is needed.
    const cases: [string, string][] = [
      ["anthropic/v1/messages", "anthropic"],
      ["openai/v1/chat/completions", "openai"],
      ["gemini/v1/generateContent", "gemini"],
      ["unmanaged", "unmanaged"],
    ];
    for (const [apiType, expected] of cases) {
      const u = extractDatabricksLog({
        destination_type: "EXTERNAL_FOUNDATION_MODEL",
        api_type: apiType,
      });
      expect(u.provider).toBe(expected);
    }
  });

  it("hosted provider cannot match a vendor price table", () => {
    // provider="databricks" is deliberate: it matches no vendor in VENDOR_MAP, so
    // the lookup CANNOT hit and emit() falls back to token events. OpenRouter does
    // list bare openai/gpt-oss-20b at ~0.4x of Databricks' own DBU rate, so an
    // accidental match would under-bill 2.5-5x.
    const table = parseOpenRouter({
      data: [{ id: "openai/gpt-oss-20b", pricing: { prompt: "0.00000003" } }],
    });
    const u = extractDatabricksLog(load("hosted_chat.json"));
    expect(lookupOpenRouter(table, u.provider, u.model)).toBeNull();
  });
});

describe("Databricks gateway — STRUCT/MAP columns arrive as JSON strings", () => {
  it("token_details parses from a JSON string as well as an object", () => {
    // The SQL drivers hand back real objects, but the Statement Execution API
    // serializes STRUCT columns as JSON strings. Both must work, or the adapter
    // silently reads zeros from a string it never parsed.
    const base = {
      destination_type: "EXTERNAL_FOUNDATION_MODEL",
      api_type: "anthropic/v1/messages",
      destination_model: "claude-sonnet-4-5",
      input_tokens: "1825",
      output_tokens: "4",
    };
    const rows: Record<string, unknown>[] = [
      { ...base, token_details: '{"cache_read_input_tokens":"1812","cache_creation_input_tokens":null}' },
      { ...base, token_details: { cache_read_input_tokens: 1812 } },
    ];
    for (const row of rows) {
      const u = extractDatabricksLog(row);
      expect(u.cache_read).toBe(1812);
      expect(u.cache_write).toBe(0);
    }
  });

  it("input_tokens includes cache, so the difference stays recoverable", () => {
    // Measured, and the inverse of every provider's own response body: this table's
    // input_tokens INCLUDES cache_read and cache_write. These fixtures came from
    // calls whose response bodies reported input_tokens: 9.
    //
    // The adapter extracts faithfully rather than subtracting — billing takes
    // Databricks' own metered USD, which never touches these counts. This pins that
    // the arithmetic stays recoverable.
    for (const name of ["byok_anthropic_cache_read.json", "byok_anthropic_cache_write.json"]) {
      const u = extractDatabricksLog(load(name));
      expect(u.cache_read && u.cache_write).toBeFalsy(); // only one direction per row
      expect(u.input - u.cache_read - u.cache_write).toBe(9);
    }
  });

  it("request_tags parses from a JSON string too", () => {
    const tags: unknown[] = [
      '{"lago_subscription":"sub_acme","team":"x"}',
      { lago_subscription: "sub_acme" },
    ];
    for (const t of tags) {
      expect(resolveDatabricksSubscription({ request_tags: t })).toBe("sub_acme");
    }
  });
});

describe("Databricks gateway — attribution", () => {
  it("a real row resolves its subscription", () => {
    expect(resolveDatabricksSubscription(load("byok_openai_cache_read.json"))).toBe("sub_openai");
  });

  it("an untagged row has no subscription", () => {
    // Untagged calls do produce rows, with request_tags empty. What to do about
    // that is the caller's decision.
    // `hosted_chat.json` IS the untagged capture — its `request_tags` is `{}`. A separate
    // `untagged.json` existed and was byte-identical, so it is gone rather than kept as a
    // second name for the same bytes.
    expect(resolveDatabricksSubscription(load("hosted_chat.json"))).toBeNull();
  });

  it("missing or malformed request_tags resolve to null", () => {
    const bad: unknown[] = [null, "{}", {}, "not json", [], 7, { lago_subscription: "" }];
    for (const t of bad) {
      expect(resolveDatabricksSubscription({ request_tags: t })).toBeNull();
    }
    expect(resolveDatabricksSubscription({})).toBeNull();
  });
});

describe("Databricks gateway — failure rows bill nothing", () => {
  it("failed rows extract to zero", () => {
    // Failed calls are recorded with NULL token counts. They must extract to
    // all-zero so the caller emits nothing — the same way a Cloudflare cache hit
    // extracts to zero.
    for (const name of ["failed_null_tokens.json", "gemini_broken.json", "unmanaged_path.json"]) {
      const u = extractDatabricksLog(load(name));
      expect(nonzeroNumeric(u)).toEqual({});
    }
  });
});

describe("Databricks gateway — robustness, one malformed row must not take down a batch", () => {
  it("empty row is all zero", () => {
    const u = extractDatabricksLog({});
    expect(nonzeroNumeric(u)).toEqual({});
    expect(u.model).toBe("");
    expect(u.provider).toBe("");
    expect(u.api).toBe("databricks_gateway");
  });

  it("negative and non-numeric counts clamp to zero", () => {
    const u = extractDatabricksLog({ input_tokens: -5, output_tokens: "bogus", total_tokens: "9" });
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
  });

  it("non-string model and destination fields do not crash", () => {
    const u = extractDatabricksLog({
      destination_type: 7,
      destination_name: [],
      destination_model: {},
      api_type: null,
    });
    expect(u.model).toBe("");
    expect(u.provider).toBe("");
  });

  it("total_tokens is not mapped", () => {
    // It is derived from input+output; mapping it would double-count. Same reason
    // the Cloudflare adapter skips usage_metadata.total_tokens.
    const u = extractDatabricksLog({ input_tokens: "10", output_tokens: "5", total_tokens: "15" });
    expect(nonzeroNumeric(u)).toEqual({ input: 10, output: 5 });
  });
});

describe("Databricks gateway — captured fixtures are safe to publish", () => {
  const files = readdirSync(FIX)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const dummyUuid = /^00000000-0000-4000-8000-\d{12}$/;
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

  it.each(files)("%s contains only deterministic dummy identity fields", (name) => {
    const row = load(name);
    const serialized = JSON.stringify(row);

    expect(row.workspace_id).toMatch(/^900000000000\d{4}$/);
    expect(row.requester).toMatch(/^fixture\.user\.\d+@example\.com$/);
    expect(row.ip_address).toMatch(/^192\.0\.2\.\d+$/);
    expect(new URL(String(row.url)).hostname).toBe("fixture-workspace.cloud.databricks.example");

    expect(serialized.match(uuid) ?? []).not.toHaveLength(0);
    for (const value of serialized.match(uuid) ?? []) expect(value).toMatch(dummyUuid);
    for (const value of serialized.match(email) ?? []) expect(value).toMatch(/@example\.com$/);
    for (const value of serialized.match(ipv4) ?? []) expect(value).toMatch(/^192\.0\.2\.\d+$/);
    for (const value of serialized.match(/workspace\.default\.[A-Za-z0-9._-]+/g) ?? []) {
      expect(value).toMatch(/^workspace\.default\.fixture-credential-\d{2}$/);
    }
  });
});

// --------------------------------------------------------------------------
// Sweep — every captured fixture must extract cleanly
// --------------------------------------------------------------------------
describe("Databricks gateway — fixture sweep", () => {
  const files = readdirSync(FIX)
    .filter((f) => f.endsWith(".json"))
    .sort();

  it("has fixtures to sweep", () => {
    // A missing capture directory must read as "not covered", not as a pass.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s extracts cleanly", (name) => {
    // Without this, a capture that no named test mentions asserts nothing — 12 of the
    // files here were in exactly that state, shipped and inert.
    const row = load(name);
    const u = extractDatabricksLog(row);
    expect(u.api).toBe("databricks_gateway");
    for (const field of NUMERIC_FIELDS) {
      expect(Number.isInteger(u[field])).toBe(true);
      expect(u[field]).toBeGreaterThanOrEqual(0);
    }
    if (Object.keys(nonzeroNumeric(u)).length > 0) {
      expect(u.model).not.toBe("");
      expect(u.provider).not.toBe("");
    }
    // Must never throw on a real row, whatever its tags.
    resolveDatabricksSubscription(row);
  });

  it("has no two byte-identical fixtures", () => {
    // A duplicate file is a second name for the same evidence, and it lies about
    // coverage: three pairs existed here, one of which ("plain" Anthropic BYOK) was
    // actually the cache-write capture, so the scenario it claimed had never been
    // captured at all.
    const seen = new Map<string, string>();
    for (const name of files) {
      const digest = createHash("sha256")
        .update(readFileSync(join(FIX, name)))
        .digest("hex");
      expect(seen.has(digest), `${name} is byte-identical to ${seen.get(digest)}`).toBe(false);
      seen.set(digest, name);
    }
  });
});
