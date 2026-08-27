/**
 * Snowflake Cortex adapters — verified against real captured view rows.
 *
 * Fixtures were read from a live account's `CORTEX_REST_API_USAGE_HISTORY` and
 * `CORTEX_AI_FUNCTIONS_USAGE_HISTORY` over the SQL API, one file per scenario, exactly as
 * the adapters receive them. Hand-made rows appear
 * only where the live surface cannot produce the shape (a failed row, malformed JSON, a
 * fine-tuned model) and say so.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractSnowflakeFunctionsLog,
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
const FUNCTIONS_FIXTURES = readdirSync(FIX)
  .filter((n) => n.startsWith("functions_") && n.endsWith(".json"))
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

describe("Snowflake Cortex functions — real fixtures", () => {
  // The one function type that reports a split: `{input, output}`, no total.
  it("AI_COMPLETE row splits input and output", () => {
    const u = extractSnowflakeFunctionsLog(load("functions_ai_complete.json"));
    expect(u.input).toBe(13);
    expect(u.output).toBe(5);
    expect(u.model).toBe("claude-sonnet-4-5");
    expect(u.provider).toBe("snowflake");
    expect(u.api).toBe("snowflake_cortex_functions");
    expect(u.extras.function_name).toBe("AI_COMPLETE");
    // No total on this row, so nothing to record and no invented split to declare.
    expect(u.extras.metrics_total).toBeUndefined();
    expect(u.extras.metrics_total_only).toBeUndefined();
  });

  // The whole reason `total` is a mapped key. `AI_CLASSIFY` reports `{total: 195}` and
  // nothing else — measured, and true of five of the six function types. Leaving `total`
  // to the drift sweep extracts all-zero here, so `nonzeroNumeric()` is empty, the caller
  // emits nothing, and every task-specific AI SQL function bills ZERO with no error
  // anywhere. This test fails if `total` is ever demoted to `extras`.
  it("a {total}-only row bills its tokens instead of zero", () => {
    const u = extractSnowflakeFunctionsLog(load("functions_total_only_no_model.json"));
    expect(nonzeroNumeric(u)).toEqual({ input: 195 });
    expect(u.extras.metrics_total).toBe(195);
    // The count is Snowflake's; the split is ours, and it says so.
    expect(u.extras.metrics_total_only).toBe(true);
    expect(u.extras.metrics_unmapped).toBeUndefined();
  });

  // `AI_EMBED` reports `{total: 3}` AND a model, so the empty `MODEL_NAME` and the
  // total-only shape vary independently — an adapter keyed off one to detect the other
  // would mis-handle both of these rows.
  it("a {total}-only row with a model bills the same way", () => {
    const u = extractSnowflakeFunctionsLog(load("functions_total_only_with_model.json"));
    expect(nonzeroNumeric(u)).toEqual({ input: 3 });
    expect(u.model).toBe("snowflake-arctic-embed-m");
    expect(u.extras.metrics_total_only).toBe(true);
  });

  // The four task functions take no model argument, so `MODEL_NAME` is "" on a perfectly
  // good row.
  it("an empty MODEL_NAME is reported, not a crash", () => {
    const u = extractSnowflakeFunctionsLog(load("functions_total_only_no_model.json"));
    expect(u.model).toBe("");
    expect(u.extras.function_name).toBe("AI_CLASSIFY");
  });

  // No captured row may extract to all-zero. This is the 100% under-bill guard: five of
  // the six function types report `{total}` alone, so an adapter that maps only
  // `input`/`output` passes every other test in this file and bills nothing for them.
  it("every captured functions row bills something", () => {
    expect(FUNCTIONS_FIXTURES.length).toBeGreaterThan(0);
    for (const name of FUNCTIONS_FIXTURES) {
      const u = extractSnowflakeFunctionsLog(load(name));
      expect(Object.keys(nonzeroNumeric(u)).length, name).toBeGreaterThan(0);
      expect(u.provider, name).toBe("snowflake");
      expect(u.api, name).toBe("snowflake_cortex_functions");
    }
  });

  // What Lago is told equals what Snowflake metered, on every captured row. Sums the token
  // values out of the raw `METRICS` array and compares against the SDK's own de-overlapped
  // total. Nothing on this view overlaps — no cache key, no reasoning key, 0 of 42 rows —
  // so the two are equal by construction, and this fails if a future change makes the
  // adapter double-count (mapping `total` alongside a split) or drop a metric.
  it("billed tokens reconcile against the view's own METRICS", () => {
    for (const name of FUNCTIONS_FIXTURES) {
      const row = load(name);
      const entries = JSON.parse(row.METRICS as string) as {
        key: { metric: string; unit: string };
        value: number;
      }[];
      const metered = entries.filter((e) => e.key.unit === "tokens").reduce((sum, e) => sum + e.value, 0);
      expect(deoverlappedTokenTotal(extractSnowflakeFunctionsLog(row)), name).toBe(metered);
    }
  });

  // `CREDITS` is what a customer sees in Snowflake's own cost view, so it is what they
  // reconcile against — and it is not a billing input. There is no price mode on this
  // path: no credit rate, no dollar figure, no cost event.
  it("CREDITS are recorded and never billed", () => {
    const u = extractSnowflakeFunctionsLog(load("functions_ai_complete.json"));
    expect(u.extras.credits).toBe("0.000068400");
    expect(Object.keys(nonzeroNumeric(u)).sort()).toEqual(["input", "output"]);
    expect(Object.keys(u.extras).filter((k) => k.includes("cost") || k.includes("usd"))).toEqual([]);
  });

  // `QUERY_ID` is the row id the caller's idempotency key is built from — rows are per
  // query, and a key derived from the hour bucket instead collapses the twelve identical
  // calls that share one bucket into a single event. It stays in `extras` rather than the
  // dimensions purely on cardinality grounds; `FUNCTION_NAME` and `MODEL_NAME` are the
  // dimensions worth grouping by.
  it("row identity and grouping keys are read", () => {
    const u = extractSnowflakeFunctionsLog(load("functions_query_tag.json"));
    expect(u.extras.query_id).toBe("01c67fd2-0302-c6c5-001e-6063000320e6");
    expect(u.extras.function_name).toBe("AI_COMPLETE");
    expect(u.model).toBe("llama3.1-8b");
    expect(u.extras.warehouse_id).toBe("21");
    expect(u.extras.is_completed).toBe("true");
    // `timestamp_ltz`, so a bare epoch — not REST's "epoch nanos offset" triple. Handed
    // over unparsed; the caller stamps the event.
    expect(u.extras.start_time).toBe("1787162400");
    expect(u.extras.end_time).toBe("1787166000");
  });

  // Unlike the REST view, this one carries `ROLE_NAMES` — and a Snowflake-written
  // `QUERY_TAG` (`{"app": "cortex_code_sandbox"}`) that must not be read as an id.
  it("a real functions row resolves through ROLE_NAMES", () => {
    expect(resolveSnowflakeSubscription(load("functions_large_prompt.json"))).toBe("LAGO_CORTEX_ROLE");
    const tagged = load("functions_query_tag.json");
    expect(resolveSnowflakeSubscription(tagged, ["query_tag"])).toBe(null);
    expect(resolveSnowflakeSubscription(tagged)).toBe("ACCOUNTADMIN");
  });

  // The SQL API serializes ARRAY columns as TEXT; a typed connector hands back a real
  // array. Reading zeros out of one of them is a silent 100% under-bill.
  it("METRICS accepted as an array, not only a JSON string", () => {
    const row = load("functions_ai_complete.json");
    const asString = extractSnowflakeFunctionsLog(row);
    row.METRICS = JSON.parse(row.METRICS as string);
    expect(nonzeroNumeric(extractSnowflakeFunctionsLog(row))).toEqual(nonzeroNumeric(asString));
  });
});

describe("Snowflake Cortex functions — shapes the live surface cannot produce", () => {
  // Unobserved — no captured row reports both (0 of 42). Guarded because it is the one
  // shape where mapping `total` double-bills: 12 real tokens billed as 24.
  it("a split row that also reports a total bills the split only", () => {
    const u = extractSnowflakeFunctionsLog({
      FUNCTION_NAME: "AI_COMPLETE",
      METRICS:
        '[{"key": {"metric": "input", "unit": "tokens"}, "value": 10},' +
        ' {"key": {"metric": "output", "unit": "tokens"}, "value": 2},' +
        ' {"key": {"metric": "total", "unit": "tokens"}, "value": 12}]',
    });
    expect(nonzeroNumeric(u)).toEqual({ input: 10, output: 2 });
    expect(u.extras.metrics_total).toBe(12);
    expect(u.extras.metrics_total_only).toBeUndefined();
  });

  // A failed call produces NO row on this view either (driven live: a 403 and a 400
  // alongside a success; only the success appeared). This row is hypothetical, and with no
  // metric and no credits there is nothing to say — the markers must stay off, or every
  // ignorable row looks like lost revenue.
  it("a failed or empty row extracts to all-zero and is not marked", () => {
    const u = extractSnowflakeFunctionsLog({
      FUNCTION_NAME: "AI_COMPLETE",
      MODEL_NAME: "claude-sonnet-4-5",
      METRICS: null,
      CREDITS: null,
      IS_COMPLETED: "true",
    });
    expect(nonzeroNumeric(u)).toEqual({});
    expect(u.model).toBe("claude-sonnet-4-5");
    expect(u.extras.metrics_unmapped).toBeUndefined();
    expect(u.extras.metrics_total_only).toBeUndefined();
  });

  // Malformed JSON bills zero — but `CREDITS` proves Snowflake charged for the row, so
  // this is lost revenue rather than an ignorable failure and it says so.
  it("malformed METRICS JSON degrades without throwing and is marked", () => {
    const u = extractSnowflakeFunctionsLog({
      FUNCTION_NAME: "AI_SUMMARIZE",
      METRICS: "[not json",
      CREDITS: "0.000271050",
    });
    expect(nonzeroNumeric(u)).toEqual({});
    expect(u.extras.function_name).toBe("AI_SUMMARIZE");
    expect(u.extras.metrics_unmapped).toBe(true);
  });

  // A metric name nobody has classified must not be miscounted as one of the three mapped
  // ones, and must not vanish. Cortex adds functions continually, and the sibling REST view
  // grew two token keys and a whole column inside one day.
  it("an unmapped metric reaches extras and is not counted", () => {
    const u = extractSnowflakeFunctionsLog({
      METRICS:
        '[{"key": {"metric": "input", "unit": "tokens"}, "value": 100},' +
        ' {"key": {"metric": "guardrail", "unit": "tokens"}, "value": 42}]',
    });
    expect(nonzeroNumeric(u)).toEqual({ input: 100 });
    expect(u.extras["metrics.guardrail"]).toBe(42);
    expect(u.extras["metrics.input"]).toBeUndefined();
  });

  // `METRICS` is a metric NAME plus a UNIT and only the pair means anything — Cortex meters
  // `AI_PARSE_DOCUMENT` per page. Billing 12 pages as 12 tokens is wrong in a way no later
  // test can see, so a foreign unit goes to the sweep — and because that leaves the row
  // billing zero, it is marked.
  it("a metric measured in something other than tokens is not billed as tokens", () => {
    const u = extractSnowflakeFunctionsLog({
      FUNCTION_NAME: "AI_PARSE_DOCUMENT",
      METRICS: '[{"key": {"metric": "input", "unit": "pages"}, "value": 12}]',
      CREDITS: "0.010000000",
    });
    expect(nonzeroNumeric(u)).toEqual({});
    expect(u.extras["metrics.input.pages"]).toBe(12);
    expect(u.extras.metrics_unmapped).toBe(true);
  });

  // `METRICS` is a list, not an object, so it can carry a metric twice. Last-wins would
  // drop the first value with nothing to show for it.
  it("a metric repeated in the array is summed", () => {
    const u = extractSnowflakeFunctionsLog({
      METRICS:
        '[{"key": {"metric": "input", "unit": "tokens"}, "value": 30},' +
        ' {"key": {"metric": "input", "unit": "tokens"}, "value": 12}]',
    });
    expect(u.input).toBe(42);
  });

  // Hypothetical row, but no longer a hypothetical CASE. Measured 2026-08-26: an in-flight
  // query writes no row at all (19 polls over the 937s one ran, nothing), and the row lands
  // 141s after the query ends already `true` and never moves — so FALSE is not reachable the
  // way this test once guessed. It IS reachable across an hour boundary, where the flag means
  // "completed in THIS aggregation window" and one query writes a row per bucket. The adapter
  // extracts what is there and passes the flag to the caller, who owns the window and
  // idempotency rules.
  it("an incomplete row is handed over rather than judged", () => {
    const u = extractSnowflakeFunctionsLog({
      FUNCTION_NAME: "AI_COMPLETE",
      IS_COMPLETED: "false",
      METRICS: '[{"key": {"metric": "total", "unit": "tokens"}, "value": 7}]',
      CREDITS: "0.000000900",
    });
    expect(u.extras.is_completed).toBe("false");
    expect(nonzeroNumeric(u)).toEqual({ input: 7 });
  });

  it("lowercase functions column keys are accepted", () => {
    const u = extractSnowflakeFunctionsLog({
      function_name: "AI_SENTIMENT",
      model_name: "",
      metrics: '[{"key": {"metric": "total", "unit": "tokens"}, "value": 21}]',
    });
    expect(u.input).toBe(21);
    expect(u.extras.function_name).toBe("AI_SENTIMENT");
  });

  // A window of rows runs through this; one bad row must not take the run down.
  it("the functions extractor never throws on a malformed row", () => {
    const rows: Record<string, unknown>[] = [
      {},
      { METRICS: 7 },
      { METRICS: "{}" },
      { METRICS: '[{"key": "input", "value": 5}]' },
      { METRICS: '[["input", 5]]' },
      { METRICS: '[{"key": {"metric": "input"}, "value": "n/a"}]' },
      { MODEL_NAME: 42, CREDITS: "n/a" },
    ];
    for (const row of rows) {
      const u = extractSnowflakeFunctionsLog(row);
      expect(nonzeroNumeric(u)).toEqual({});
      expect(u.api).toBe("snowflake_cortex_functions");
    }
  });

  // Two unusable entries must not collide in `extras`, and neither may disappear.
  it("an array entry of the wrong shape is kept by position", () => {
    const u = extractSnowflakeFunctionsLog({ METRICS: '["input", "output"]' });
    expect(u.extras["metrics.0"]).toBe("input");
    expect(u.extras["metrics.1"]).toBe("output");
  });
});
