/**
 * Snowflake Cortex REST adapter — verified against real captured view rows.
 *
 * Fixtures were read from a live account's `CORTEX_REST_API_USAGE_HISTORY` over the SQL
 * API, one file per scenario, exactly as the adapter receives them. Hand-made rows appear
 * only where the live surface cannot produce the shape (a failed row, malformed JSON, a
 * fine-tuned model) and say so.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractSnowflakeRestLog,
  resolveSnowflakeSubscription,
} from "../../../../src/gateway/adapters/index.js";
import { nonzeroNumeric } from "../../../../src/canonical.js";
import { deoverlappedTokenTotal } from "../../../../src/pricing.js";

const FIX = join(__dirname, "fixtures", "snowflake_cortex");
const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const REST_FIXTURES = readdirSync(FIX)
  .filter((n) => n.startsWith("rest_") && n.endsWith(".json"))
  .sort();

describe("Snowflake Cortex REST — real fixtures", () => {
  it("plain row", () => {
    const u = extractSnowflakeRestLog(load("rest_plain.json"));
    expect(u.input).toBe(9);
    expect(u.output).toBe(12);
    expect(u.cache_read).toBe(0);
    expect(u.cache_write).toBe(0);
    expect(u.model).toBe("claude-sonnet-4-5");
    expect(u.provider).toBe("snowflake");
    expect(u.api).toBe("snowflake_cortex_rest");
  });

  // `input` EXCLUDES the cached block on this view — the whole billing question. 8 fresh
  // input tokens, 4,684 served from cache, 6 generated, and `TOKENS: 4698` is their sum.
  // Reading that total as the input count, or assuming OpenAI's convention where the
  // cached block sits inside `input`, bills 2.0x.
  it("cache-read row is additive", () => {
    const u = extractSnowflakeRestLog(load("rest_cache_read.json"));
    expect(u.input).toBe(8);
    expect(u.cache_read).toBe(4684);
    expect(u.cache_write).toBe(0);
    expect(u.output).toBe(6);
  });

  // The write half of a matched pair: the same prompt, sent twice, reported identically by
  // the endpoint (`cached_tokens: 4684, cache_write_tokens: 0` both times) and split by the
  // view into a write row and a read row.
  it("cache-write row", () => {
    const u = extractSnowflakeRestLog(load("rest_cache_write.json"));
    expect(u.cache_write).toBe(4684);
    expect(u.cache_read).toBe(0);
    expect(u.input).toBe(8);
    expect(u.output).toBe(6);
  });

  // Extended thinking is INSIDE `output` here and has no key of its own. The same call
  // reported `thinking_tokens: 127` of 262 output tokens on Snowflake's Anthropic wire; the
  // view reports only `{input: 60, output: 262}`. A `reasoning` count invented from that
  // would be billed twice.
  it("thinking row reports no reasoning", () => {
    const u = extractSnowflakeRestLog(load("rest_thinking.json"));
    expect(u.output).toBe(262);
    expect(u.reasoning).toBe(0);
    expect(u.input).toBe(60);
  });

  // `TOKENS` == the SDK's own de-overlapped total, on every captured row. This is the
  // reconciliation INT-231 exists to prove, asserted here on the two inputs it depends on:
  // that the adapter maps the granular keys, and that nothing downstream treats this
  // surface as OpenAI-shaped. Adding `snowflake_cortex_rest` to `OPENAI_SHAPED_APIS` — or
  // `snowflake` to `INPUT_INCLUDES_CACHE_READ` — zeroes `cache_read` here and drops a
  // cached row from 4698 to 14, which this fails on.
  it("every real row reconciles against Snowflake's own TOKENS", () => {
    expect(REST_FIXTURES.length, "no rest_*.json fixtures — capture is missing, not passing").toBeGreaterThan(
      0,
    );
    for (const name of REST_FIXTURES) {
      const row = load(name);
      const usage = extractSnowflakeRestLog(row);
      expect(deoverlappedTokenTotal(usage), name).toBe(parseInt(String(row.TOKENS), 10));
    }
  });

  // `TOKENS` is the additive total; mapping it double-bills the cached block. It reaches
  // `extras` so a reconciliation can read it, and no numeric field. Mirrors the Databricks
  // adapter's refusal to map that table's `total_tokens`.
  it("TOKENS is never mapped to a token field", () => {
    const row = load("rest_cache_read.json");
    const u = extractSnowflakeRestLog(row);
    const total = parseInt(String(row.TOKENS), 10);
    expect(u.extras.tokens).toBe(row.TOKENS);
    expect(u.input + u.output + u.cache_read + u.cache_write).toBe(total);
    expect(u.input).not.toBe(total);
  });

  it("non-token columns reach extras", () => {
    const u = extractSnowflakeRestLog(load("rest_cache_write.json"));
    expect(u.extras.request_id).toBe("7d1649a5-1460-4786-acac-5dd74666d9c7");
    expect(u.extras.inference_region).toBe("");
    expect(u.extras.user_id).toBe("1");
    expect(u.extras.query_tag).toBeNull();
    expect(u.extras.start_time).toBe("1787680800.000000000 1440");
    expect(u.extras.end_time).toBe("1787684400.000000000 1440");
  });
});

describe("Snowflake Cortex REST — shapes the live surface cannot produce", () => {
  // A failed call produces NO row on this view (driven live: a 403 and a 400 alongside a
  // success; only the success appeared). This row is therefore hypothetical — it guards the
  // shape a mid-generation failure would take.
  it("failed row extracts to all-zero", () => {
    const u = extractSnowflakeRestLog({
      REQUEST_ID: "00000000-0000-0000-0000-000000000000",
      MODEL_NAME: "claude-sonnet-4-5",
      TOKENS: null,
      TOKENS_GRANULAR: null,
      USER_ID: "1",
    });
    expect(nonzeroNumeric(u)).toEqual({});
    expect(u.model).toBe("claude-sonnet-4-5");
    // No `TOKENS` to contradict the zeros, so this is a genuinely empty row rather than
    // usage we failed to split — the marker must stay off.
    expect(u.extras.tokens_granular_missing).toBeUndefined();
  });

  // Real usage the adapter cannot split extracts to all-zero, so nothing is emitted — a
  // 100% under-bill that must not look like a correctly-ignored failure.
  it("positive TOKENS with no granular is marked, not silently dropped", () => {
    const u = extractSnowflakeRestLog({ TOKENS: "4818", TOKENS_GRANULAR: null });
    expect(nonzeroNumeric(u)).toEqual({});
    expect(u.extras.tokens_granular_missing).toBe(true);
  });

  // The drift sweep alone would let this pass quietly: every count is preserved in
  // `extras`, but nothing is billable and `TOKENS` says the call consumed 500.
  it("granular holding only unknown keys is marked too", () => {
    const u = extractSnowflakeRestLog({ TOKENS: "500", TOKENS_GRANULAR: '{"audio_input": 500}' });
    expect(nonzeroNumeric(u)).toEqual({});
    expect(u.extras["tokens_granular.audio_input"]).toBe(500);
    expect(u.extras.tokens_granular_missing).toBe(true);
  });

  it("malformed granular JSON degrades without throwing", () => {
    const u = extractSnowflakeRestLog({
      MODEL_NAME: "llama3.1-70b",
      TOKENS: "20",
      TOKENS_GRANULAR: "{not json",
    });
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(u.model).toBe("llama3.1-70b");
    expect(u.extras.tokens).toBe("20");
  });

  // The SQL API serializes OBJECT columns as TEXT; a typed connector hands back a real
  // object. Reading zeros out of one of them is a silent 100% under-bill.
  it("granular accepted as an object, not only a JSON string", () => {
    const asString = extractSnowflakeRestLog(load("rest_cache_read.json"));
    const row = load("rest_cache_read.json");
    row.TOKENS_GRANULAR = JSON.parse(String(row.TOKENS_GRANULAR));
    expect(nonzeroNumeric(extractSnowflakeRestLog(row))).toEqual(nonzeroNumeric(asString));
  });

  // A new key here is a token count nobody has classified. It must not be miscounted as one
  // of the four mapped fields, and it must not vanish — this view grew two cache keys and a
  // whole column inside one day.
  it("unmapped granular key reaches extras and is not counted", () => {
    const u = extractSnowflakeRestLog({
      TOKENS: "1300",
      TOKENS_GRANULAR: '{"input": 1000, "output": 200, "cache_read_input": 100, "image_input_tokens": 42}',
    });
    expect(u.input).toBe(1000);
    expect(u.output).toBe(200);
    expect(u.cache_read).toBe(100);
    expect(u.extras["tokens_granular.image_input_tokens"]).toBe(42);
    expect(u.image_input).toBe(0);
    expect(u.extras["tokens_granular.input"]).toBeUndefined();
  });

  // Fully-qualified `database.schema.model`. Normalizing for a price lookup is pricing's
  // job; what Lago is told the model was must be what the customer typed. Hand-made — only
  // four bare models are live on the capture account.
  it("fine-tuned model keeps the customer's spelling", () => {
    const u = extractSnowflakeRestLog({
      MODEL_NAME: "MY_DB.MY_SCHEMA.my_tuned_llama",
      TOKENS_GRANULAR: '{"input": 5}',
    });
    expect(u.model).toBe("MY_DB.MY_SCHEMA.my_tuned_llama");
  });

  // Unquoted identifiers arrive UPPERCASE, but a quoted lowercase alias — or a caller who
  // normalized keys — must not extract zeros from a row that has values.
  it("lowercase column keys are accepted", () => {
    const u = extractSnowflakeRestLog({
      model_name: "claude-opus-4-5",
      tokens: "16",
      tokens_granular: '{"input": 8, "output": 8}',
    });
    expect(u.input).toBe(8);
    expect(u.output).toBe(8);
    expect(u.model).toBe("claude-opus-4-5");
  });

  // A backfill runs a window of rows through this; one bad row must not take the run down.
  it("never throws on a malformed row", () => {
    for (const row of [{}, { TOKENS_GRANULAR: 7 }, { TOKENS_GRANULAR: [] }, { MODEL_NAME: 42 }]) {
      const u = extractSnowflakeRestLog(row as Record<string, unknown>);
      expect(nonzeroNumeric(u)).toEqual({});
      expect(u.api).toBe("snowflake_cortex_rest");
    }
  });
});

describe("Snowflake Cortex — subscription resolution", () => {
  it("resolves from QUERY_TAG", () => {
    expect(resolveSnowflakeSubscription({ QUERY_TAG: '{"lago_subscription": "sub_123"}' })).toBe("sub_123");
  });

  // Snowflake writes its own QUERY_TAGs — a captured row carries
  // `{"app": "cortex_code_sandbox", ...}`. Treating an arbitrary tag as a subscription id
  // bills somebody's tooling label to a customer.
  it("a QUERY_TAG without the key resolves nothing from that source", () => {
    expect(resolveSnowflakeSubscription({ QUERY_TAG: '{"app": "cortex_code_sandbox"}' }, ["query_tag"])).toBe(
      null,
    );
  });

  it("a non-JSON QUERY_TAG is ignored", () => {
    expect(resolveSnowflakeSubscription({ QUERY_TAG: "nightly-etl" }, ["query_tag"])).toBe(null);
  });

  it("falls through ROLE_NAMES then USER_ID", () => {
    const row = { ROLE_NAMES: '["TENANT_ACME", "PUBLIC"]', USER_ID: "1" };
    expect(resolveSnowflakeSubscription(row)).toBe("TENANT_ACME");
    expect(resolveSnowflakeSubscription(row, ["user_id"])).toBe("1");
  });

  // Numeric column: "1" over the SQL API, 1 from a typed connector. Two spellings of one row
  // must not bill to two different subscriptions.
  it("USER_ID is the same id whichever way the row was read", () => {
    expect(resolveSnowflakeSubscription({ USER_ID: "1" }, ["user_id"])).toBe("1");
    expect(resolveSnowflakeSubscription({ USER_ID: 1 }, ["user_id"])).toBe("1");
  });

  it("order is honoured and first hit wins", () => {
    const row = {
      QUERY_TAG: '{"lago_subscription": "sub_tag"}',
      ROLE_NAMES: '["TENANT_ACME"]',
      USER_ID: "1",
    };
    expect(resolveSnowflakeSubscription(row)).toBe("sub_tag");
    expect(resolveSnowflakeSubscription(row, ["role_names", "query_tag"])).toBe("TENANT_ACME");
    expect(resolveSnowflakeSubscription(row, [])).toBe(null);
  });

  // The honest state of this view: no QUERY_TAG value has ever been observed on it and it
  // has no ROLE_NAMES at all, so the default order reaches `USER_ID` — a Snowflake identity,
  // not a Lago subscription. A caller without that mapping should pass `["query_tag"]` and
  // let the row go unattributed.
  it("a real REST row resolves to the Snowflake user only", () => {
    const row = load("rest_plain.json");
    expect(resolveSnowflakeSubscription(row)).toBe("1");
    expect(resolveSnowflakeSubscription(row, ["query_tag"])).toBe(null);
  });
});

describe("Snowflake Cortex — coercion edges", () => {
  // ARRAY columns arrive as TEXT over the SQL API and as a real array from a typed
  // connector — the same row must attribute the same way through either.
  it("ROLE_NAMES accepted as an array, not only a JSON string", () => {
    expect(resolveSnowflakeSubscription({ ROLE_NAMES: ["TENANT_ACME"] })).toBe("TENANT_ACME");
  });

  it("malformed ROLE_NAMES resolves nothing rather than throwing", () => {
    const row = { ROLE_NAMES: "[not json", USER_ID: "1" };
    expect(resolveSnowflakeSubscription(row, ["role_names"])).toBe(null);
    expect(resolveSnowflakeSubscription(row)).toBe("1");
  });

  // `TOKENS` is only ever read to decide whether zeros mean "no usage" or "usage we could
  // not split", so a value that is not a number must degrade, not throw.
  it("a non-numeric TOKENS column does not throw", () => {
    const u = extractSnowflakeRestLog({ TOKENS: "n/a", TOKENS_GRANULAR: null });
    expect(nonzeroNumeric(u)).toEqual({});
    expect(u.extras.tokens_granular_missing).toBeUndefined();
  });
});
