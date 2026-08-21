/**
 * Databricks usage reader — the I/O half, exercised without touching a warehouse.
 *
 * `DatabricksSource.query` is faked here; the SQL it would run is asserted, and the
 * COLUMNAR response shape is reproduced exactly as the Statement Execution API returns
 * it (`manifest.schema.columns` plus a positional `data_array`, one chunk inline).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LagoSDK } from "../../../src/sdk.js";
import { DatabricksSource, DatabricksUsageRow, intervalSql } from "../../../src/gateway/databricks.js";
import { nonzeroNumeric, makeCanonicalUsage } from "../../../src/canonical.js";

// --------------------------------------------------------------------------
// Fake rows, in the exact shapes the two tables return
// --------------------------------------------------------------------------
const HOSTED: Record<string, unknown> = {
  invocation_id: "inv-hosted-1",
  request_id: "req-hosted-1",
  event_time: "2026-08-07 14:22:03.123",
  destination_type: "PAY_PER_TOKEN_FOUNDATION_MODEL",
  destination_name: "system.ai.llama-4-maverick",
  destination_model: "llama-4-maverick",
  api_type: "mlflow/v1/chat/completions",
  endpoint_name: "system.ai.llama-4-maverick",
  input_tokens: "11",
  output_tokens: "4",
  request_tags: '{"lago_subscription":"sub_hosted"}',
};

const BYOK_USAGE: Record<string, unknown> = {
  invocation_id: "inv-byok-1",
  request_id: "req-byok-1",
  event_time: "2026-08-07 14:22:59.900",
  destination_type: "EXTERNAL_FOUNDATION_MODEL",
  destination_name: "workspace.default.anthropickey",
  destination_model: "claude-sonnet-4-5",
  api_type: "anthropic/v1/messages",
  endpoint_name: "workspace.default.anthropickey",
  status_code: "200",
  input_tokens: "1825",
  output_tokens: "47",
  token_details: '{"cache_read_input_tokens":1812}',
  request_tags: '{"lago_subscription":"sub_byok"}',
};

const BYOK_SPEND: Record<string, unknown> = {
  record_id: "rec-1",
  bucket: "2026-08-07 14:00:00",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  request_tags: '{"lago_subscription":"sub_byok"}',
  usage_quantity: "0.0011187",
};

const FAILED: Record<string, unknown> = {
  invocation_id: "inv-failed",
  event_time: "2026-08-07 14:30:00",
  destination_type: "PAY_PER_TOKEN_FOUNDATION_MODEL",
  destination_name: "system.ai.gpt-oss-20b",
  api_type: "mlflow/v1/chat/completions",
  input_tokens: null,
  output_tokens: null,
  status_code: "403",
};

/** A source whose `query` answers from canned rows, keyed on which table. */
function source(
  spend: Record<string, unknown>[],
  usage: Record<string, unknown>[],
): DatabricksSource & { queries: string[] } {
  const src = new DatabricksSource("https://x", "t", "w") as DatabricksSource & { queries: string[] };
  src.queries = [];
  src.query = (sql: string) => {
    src.queries.push(sql);
    return Promise.resolve(sql.includes("external_model_spend") ? spend : usage);
  };
  return src;
}

// --------------------------------------------------------------------------
// The window
// --------------------------------------------------------------------------
describe("Databricks reader — the window", () => {
  it("renders interval strings to SQL", () => {
    expect(intervalSql("1 day")).toBe("current_timestamp() - INTERVAL 1 DAY");
    expect(intervalSql("36 hours")).toBe("current_timestamp() - INTERVAL 36 HOUR");
    expect(intervalSql("30 minutes")).toBe("current_timestamp() - INTERVAL 30 MINUTE");
  });

  it("renders a Date window as a literal", () => {
    expect(intervalSql(new Date(Date.UTC(2026, 7, 7, 14, 0, 0)))).toBe("TIMESTAMP '2026-08-07 14:00:00'");
  });

  // The window reaches SQL by interpolation, so validation is the only thing standing
  // between a caller's string and the warehouse.
  it.each(["1 day; DROP TABLE system.ai_gateway.usage", "1 day OR 1=1", "yesterday", "-1 day", ""])(
    "refuses %j rather than interpolating it",
    (bad) => {
      expect(() => intervalSql(bad)).toThrow(/not understood/);
    },
  );

  it("scopes both queries to the window", async () => {
    const src = source([], []);
    await src.readUsage("3 days");
    expect(src.queries).toHaveLength(2);
    for (const sql of src.queries) expect(sql).toContain("current_timestamp() - INTERVAL 3 DAY");
  });
});

// --------------------------------------------------------------------------
// The BYOK / hosted split — the double-billing guard
// --------------------------------------------------------------------------
describe("Databricks reader — BYOK/hosted split", () => {
  it("bills BYOK once from spend and hosted once from usage", async () => {
    // A BYOK call appears in BOTH tables. It must yield exactly one row, carrying
    // Databricks' own metered USD; the token row it also has must not become a second
    // billable row.
    const rows = await source([BYOK_SPEND], [HOSTED, BYOK_USAGE]).readUsage("1 day");
    expect(rows).toHaveLength(2);

    const byok = rows.filter((r) => r.isByok);
    const hosted = rows.filter((r) => !r.isByok);
    expect(byok).toHaveLength(1);
    expect(hosted).toHaveLength(1);
    expect(byok[0].usdCost).toBeCloseTo(0.0011187, 10);
    expect(byok[0].usage.model).toBe("claude-sonnet-4-5");
    expect(hosted[0].usage.model).toBe("llama-4-maverick");
    expect(hosted[0].usdCost).toBeUndefined();
  });

  it("carries the token counts joined from the usage table", async () => {
    // The dollar figure is authoritative, but the event should still report real
    // tokens — joined on (hour, provider, model, tags), the spend table's own key.
    const rows = await source([BYOK_SPEND], [BYOK_USAGE]).readUsage("1 day");
    const byok = rows.find((r) => r.isByok)!;
    expect(byok.usage.input).toBe(1825);
    expect(byok.usage.output).toBe(47);
    expect(byok.usage.cache_read).toBe(1812);
  });

  it("sums the tokens of several calls in one spend bucket", async () => {
    // The spend table aggregates per (hour, model, provider, tags), so N calls in the
    // same hour collapse to ONE dollar row while `ai_gateway.usage` still holds N token
    // rows. Reporting only the first would understate the tokens behind a cost the
    // customer can see — so they sum.
    const second = { ...BYOK_USAGE, invocation_id: "inv-byok-2", input_tokens: "100", output_tokens: "3" };
    const [byok] = await source([BYOK_SPEND], [BYOK_USAGE, second]).readUsage("1 day");
    expect(byok.usage.input).toBe(1925);
    expect(byok.usage.output).toBe(50);
    expect(byok.usage.cache_read).toBe(3624);
    // Still ONE event: the dollar figure already covers both calls.
    expect(byok.usdCost).toBeCloseTo(0.0011187, 10);
  });

  it("merges tokens only within the same hour", async () => {
    // The bucket is part of the join key, so a call in the next hour belongs to a
    // different spend row and must not inflate this one.
    const nextHour = { ...BYOK_USAGE, invocation_id: "inv-byok-3", event_time: "2026-08-07 15:04:00" };
    const [byok] = await source([BYOK_SPEND], [BYOK_USAGE, nextHour]).readUsage("1 day");
    expect(byok.usage.input).toBe(1825);
  });

  it("does not crash the join on unparseable request_tags", async () => {
    // A tag column that isn't JSON still has to produce a stable key rather than
    // throwing — one malformed row must not take down the batch.
    const rows = await source([{ ...BYOK_SPEND, request_tags: "not json" }], [BYOK_USAGE]).readUsage("1 day");
    expect(rows).toHaveLength(1);
    expect(rows[0].usdCost).toBeCloseTo(0.0011187, 10);
  });

  it("still bills a spend row whose usage row is missing", async () => {
    // A join miss (a row aggregated across an hour boundary, say) must not drop
    // revenue — the cost is what Databricks charged either way, just with no tokens.
    const [byok] = await source([BYOK_SPEND], []).readUsage("1 day");
    expect(byok.usdCost).toBeCloseTo(0.0011187, 10);
    expect(byok.usage.model).toBe("claude-sonnet-4-5");
    expect(byok.usage.provider).toBe("anthropic");
    expect(nonzeroNumeric(byok.usage)).toEqual({});
  });

  it("skips zero-dollar spend rows", async () => {
    const rows = await source([{ ...BYOK_SPEND, usage_quantity: "0" }], []).readUsage("1 day");
    expect(rows).toEqual([]);
  });

  it("yields nothing for failed calls", async () => {
    // 403/404s are recorded with NULL token counts. Emitting them would bill an empty
    // event for a call that never reached a provider.
    expect(await source([], [FAILED]).readUsage("1 day")).toEqual([]);
  });

  it("keeps the databricks provider on hosted rows", async () => {
    // Which is what makes the price lookup miss deliberately rather than matching some
    // other vendor's rate for a DBU-billed model.
    const [hosted] = await source([], [HOSTED]).readUsage("1 day");
    expect(hosted.usage.provider).toBe("databricks");
    expect(hosted.usage.api).toBe("databricks_gateway");
  });
});

// --------------------------------------------------------------------------
// Chunked results — the silent-truncation guard
// --------------------------------------------------------------------------
describe("Databricks reader — query", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("zips columns and follows every chunk", async () => {
    // Only chunk 0 arrives inline. A reader that stops there works on a small window
    // and silently bills a fraction of a large one — so all total_chunk_count chunks
    // are fetched and the columnar rows zipped back into objects.
    const first = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: {
        schema: { columns: [{ name: "invocation_id" }, { name: "input_tokens" }] },
        total_chunk_count: 3,
      },
      result: { data_array: [["a", "1"]] },
    };
    const chunks: Record<string, unknown> = {
      "1": { data_array: [["b", "2"]] },
      "2": { data_array: [["c", "3"]] },
    };
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: { method?: string }) => {
      if (init?.method === "POST")
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(first) });
      fetched.push(url);
      const index = url.split("/").pop() as string;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(chunks[index]) });
    });

    const rows = await new DatabricksSource("https://x/", "t", "w").query("SELECT 1");
    expect(rows).toEqual([
      { invocation_id: "a", input_tokens: "1" },
      { invocation_id: "b", input_tokens: "2" },
      { invocation_id: "c", input_tokens: "3" },
    ]);
    expect(fetched.map((u) => u.split("/").pop())).toEqual(["1", "2"]);
    for (const u of fetched) {
      expect(u.startsWith("https://x/api/2.0/sql/statements/stmt-1/result/chunks/")).toBe(true);
    }
  });

  it("raises when a chunk fetch fails", async () => {
    // A failed chunk fetch must NOT be swallowed into a short row set. The error body
    // carries no data_array, so `?? []` would push nothing, the loop would move to the
    // next index, and query() would return a partial window reporting success. Measured
    // against a live warehouse: a 403 on chunk 1 of 2 returned 6,750 of 9,000 rows with
    // no exception — 25% of the window billed as if it were all of it.
    const first = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: {
        schema: { columns: [{ name: "invocation_id" }, { name: "input_tokens" }] },
        total_chunk_count: 2,
      },
      result: { data_array: [["a", "1"]] },
    };
    // exactly what the API returns for an expired statement / revoked token mid-read
    const denied = { error_code: "PERMISSION_DENIED", message: "does not have required scopes: sql" };
    vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST")
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(first) });
      return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve(denied) });
    });

    const src = new DatabricksSource("https://x/", "t", "w");
    await expect(src.query("SELECT 1")).rejects.toThrow(/result chunk 1 of 2/);
    // the operator must see the API's own cause, not just a status line
    await expect(src.query("SELECT 1")).rejects.toThrow(/does not have required scopes: sql/);
  });

  it("raises when the row count misses the manifest", async () => {
    // A chunk that returns HTTP 200 with fewer rows than promised is still truncation.
    // No per-request status check can catch that, so the assembled count is compared
    // with manifest.total_row_count before any of it is billed.
    const first = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: {
        schema: { columns: [{ name: "invocation_id" }] },
        total_chunk_count: 2,
        total_row_count: 3,
      },
      result: { data_array: [["a"]] },
    };
    vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST")
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(first) });
      // HTTP 200, but one row short of the promised three
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data_array: [["b"]] }) });
    });

    await expect(new DatabricksSource("https://x/", "t", "w").query("SELECT 1")).rejects.toThrow(
      /returned 2 row\(s\) but the manifest promised 3/,
    );
  });

  it("raises when rows arrive with no columns", async () => {
    // Rows with no column names decode to {} each, which every layer downstream degrades
    // cleanly and wrongly on — all-zero usage and a confident {cost: 0, tokens: 0} for a
    // window that had real traffic. Not observed on this API; guards the decode.
    const first = {
      statement_id: "stmt-1",
      status: { state: "SUCCEEDED" },
      manifest: { total_chunk_count: 1 },
      result: { data_array: [["a"], ["b"]] },
    };
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(first) }),
    );
    await expect(new DatabricksSource("https://x/", "t", "w").query("SELECT 1")).rejects.toThrow(
      /no `manifest\.schema\.columns`/,
    );
  });

  it("error carries the api error code", async () => {
    // A non-OK submission used to surface as `Databricks statement undefined: {...}` —
    // the state was absent, so the poll loop's own guard threw with a misleading prefix.
    // The cause was in the body all along; name it.
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error_code: "NOT_FOUND", message: "The warehouse w was not found." }),
      }),
    );
    const src = new DatabricksSource("https://x", "t", "w");
    await expect(src.query("SELECT 1")).rejects.toThrow(/statement submission failed: HTTP 404/);
    await expect(src.query("SELECT 1")).rejects.toThrow(/The warehouse w was not found\./);
    await expect(src.query("SELECT 1")).rejects.not.toThrow(/statement undefined/);
  });

  it("raises on a failed statement", async () => {
    // A FAILED statement returns 200 with the failure in the body. Reading rows from it
    // would report an empty window as "no usage" and bill nothing.
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: { state: "FAILED", error: { message: "boom" } } }),
      }),
    );
    await expect(new DatabricksSource("https://x", "t", "w").query("SELECT 1")).rejects.toThrow(/FAILED/);
  });
});

// --------------------------------------------------------------------------
// Idempotency keys
// --------------------------------------------------------------------------
describe("Databricks reader — event ids", () => {
  it("are unique per row and scoped by subscription", async () => {
    const rows = await source([BYOK_SPEND], [HOSTED, BYOK_USAGE]).readUsage("1 day");
    const ids = rows.map((r) => r.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.find((i) => i.includes("spend"))).toContain("sub_byok");
    expect(ids.find((i) => i.includes("usage"))).toContain("sub_hosted");
  });

  it("namespace the whole read by prefix", async () => {
    const rows = await source([BYOK_SPEND], [HOSTED]).readUsage("1 day", { eventIdPrefix: "tenant7" });
    expect(rows.every((r) => r.eventId.startsWith("tenant7_"))).toBe(true);
  });

  it("rescope without changing the row key", () => {
    // transaction_id is unique account-wide, so the same source row billed to two
    // subscriptions needs two ids — and the id must follow the subscription actually
    // billed, which for an untagged row is the caller's default, not the row's tag.
    const row = new DatabricksUsageRow(makeCanonicalUsage(), null, "rec-9", "spend", 1.0);
    expect(row.eventId).toBe("dbx_spend_none_rec-9");
    expect(row.eventIdFor("sub_a")).toBe("dbx_spend_sub_a_rec-9");
    expect(row.eventIdFor("sub_b")).toBe("dbx_spend_sub_b_rec-9");
  });
});

// --------------------------------------------------------------------------
// The one-liner
// --------------------------------------------------------------------------
function sdkWithRecorder(): [LagoSDK, { events: Record<string, any>[] }] {
  const rec: { events: Record<string, any>[] } = { events: [] };
  const sdk = new LagoSDK({ apiKey: "dummy" });
  sdk._setSender(async (batch) => {
    rec.events.push(...(batch as unknown as Record<string, any>[]));
  });
  return [sdk, rec];
}

async function drain(sdk: LagoSDK): Promise<void> {
  expect(await sdk.flush(2000)).toBe(true);
  await sdk.shutdown(1000);
}

describe("backfillDatabricks", () => {
  it("counts cost, tokens and skips", async () => {
    const [sdk, rec] = sdkWithRecorder();
    const src = source([BYOK_SPEND], [HOSTED, BYOK_USAGE, { ...HOSTED, request_tags: "{}" }]);
    const counts = await sdk.backfillDatabricks(src, "1 day");
    await drain(sdk);
    // The untagged row has no subscription and no default to fall back on.
    expect(counts).toEqual({ cost: 1, tokens: 1, skipped: 1 });
    expect(new Set(rec.events.map((e) => e.external_subscription_id))).toEqual(
      new Set(["sub_byok", "sub_hosted"]),
    );
  });

  it("falls back to the default subscription", async () => {
    const [sdk, rec] = sdkWithRecorder();
    const src = source([], [{ ...HOSTED, request_tags: "{}" }]);
    const counts = await sdk.backfillDatabricks(src, "1 day", { defaultSubscription: "sub_fb" });
    await drain(sdk);
    expect(counts.skipped).toBe(0);
    expect(new Set(rec.events.map((e) => e.external_subscription_id))).toEqual(new Set(["sub_fb"]));
    // ...and the id follows the subscription billed, not the row's absent tag.
    expect(rec.events.every((e) => e.transaction_id.includes("sub_fb"))).toBe(true);
  });

  it("unified ignores per-row tags", async () => {
    // One gateway serving one customer: everything lands on one subscription even
    // though the rows carry their own tags.
    const [sdk, rec] = sdkWithRecorder();
    const src = source([BYOK_SPEND], [HOSTED, BYOK_USAGE]);
    await sdk.backfillDatabricks(src, "1 day", { defaultSubscription: "sub_one", unified: true });
    await drain(sdk);
    expect(new Set(rec.events.map((e) => e.external_subscription_id))).toEqual(new Set(["sub_one"]));
    expect(rec.events.every((e) => e.transaction_id.includes("sub_one"))).toBe(true);
  });

  it("bills BYOK as cost and hosted as tokens", async () => {
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillDatabricks(source([BYOK_SPEND], [HOSTED, BYOK_USAGE]), "1 day");
    await drain(sdk);

    const cost = rec.events.filter((e) => e.code === "llm_cost");
    const tokens = rec.events.filter((e) => e.code !== "llm_cost");
    expect(cost).toHaveLength(1);
    // Databricks' own $0.0011187 -> 0.11187 cents, passed through, not recomputed.
    expect(String(cost[0].precise_total_amount_cents).startsWith("0.11187")).toBe(true);
    expect(cost[0].properties.price_source).toBe("precomputed");
    // Hosted has no dollar figure anywhere in Databricks' tables, so: token events.
    expect(new Set(tokens.map((e) => e.code))).toEqual(new Set(["llm_input_tokens", "llm_output_tokens"]));
    expect(tokens.every((e) => e.precise_total_amount_cents === undefined)).toBe(true);
  });

  it("is idempotent across a re-run", async () => {
    // Re-reading the same window must produce byte-identical transaction ids, so Lago
    // rejects the duplicates instead of double-billing.
    const runs: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const [sdk, rec] = sdkWithRecorder();
      await sdk.backfillDatabricks(source([BYOK_SPEND], [HOSTED, BYOK_USAGE]), "1 day");
      await drain(sdk);
      runs.push(rec.events.map((e) => e.transaction_id as string));
    }
    expect(runs[0]).toEqual(runs[1]);
  });

  it("survives one malformed row", async () => {
    // Instrumentation never breaks the caller: a row that extracts to nothing usable is
    // skipped, and the rows around it still bill.
    const [sdk, rec] = sdkWithRecorder();
    const src = source([BYOK_SPEND], [{ nonsense: true }, HOSTED, BYOK_USAGE]);
    const counts = await sdk.backfillDatabricks(src, "1 day", { defaultSubscription: "sub_fb" });
    await drain(sdk);
    expect(counts.cost).toBe(1);
    expect(counts.tokens).toBe(1);
    expect(rec.events.length).toBeGreaterThanOrEqual(3);
  });
});

// --------------------------------------------------------------------------
// Reconciliation dimensions — the whole point of the connector being checkable
// --------------------------------------------------------------------------
describe("reconciliation dimensions", () => {
  it("put the gateway page's own endpoint on hosted events", async () => {
    // Our `model` is normalized (`llama-4-maverick`) where the AI Gateway usage page
    // shows `system.ai.llama-4-maverick`. Without the endpoint on the event, grouping
    // Lago one way and Databricks the other fails on naming alone.
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillDatabricks(source([], [HOSTED]), "1 day");
    await drain(sdk);
    expect(rec.events.length).toBeGreaterThan(0);
    for (const e of rec.events) {
      expect(e.properties.endpoint_name).toBe("system.ai.llama-4-maverick");
    }
  });

  it("put the hour bucket on BYOK events, not a sampled endpoint", async () => {
    // A spend row covers an hour of requests, so its authoritative key is the hour —
    // external_model_spend's own aggregation key. A per-request field here would be one
    // sampled value presented as a property of the whole bucket.
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillDatabricks(source([BYOK_SPEND], [BYOK_USAGE]), "1 day");
    await drain(sdk);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0].properties.bucket).toBe("2026-08-07 14:00:00");
    expect(rec.events[0].properties.endpoint_name).toBeUndefined();
  });

  it("add caller dimensions, which win on a collision", async () => {
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillDatabricks(source([], [HOSTED]), "1 day", {
      dimensions: { team: "platform", endpoint_name: "mine" },
    });
    await drain(sdk);
    for (const e of rec.events) {
      expect(e.properties.team).toBe("platform");
      // An explicit dimension is the caller's decision, so it overrides the auto key
      // rather than being silently discarded.
      expect(e.properties.endpoint_name).toBe("mine");
    }
  });

  it("add no empty dimension when a row has no endpoint", async () => {
    // An empty string would create a phantom Lago group rather than saying nothing.
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillDatabricks(source([], [{ ...HOSTED, endpoint_name: null }]), "1 day");
    await drain(sdk);
    for (const e of rec.events) expect(e.properties.endpoint_name).toBeUndefined();
  });

  it("drop per-request extras from a merged bucket but keep the endpoint", async () => {
    // invocation_id and status_code describe one request. Carrying them on an hourly
    // aggregate states one sampled request's value as if it covered the hour — and once
    // dimensions are emitted from extras, that becomes a live mis-statement.
    const second = { ...BYOK_USAGE, invocation_id: "inv-byok-2", input_tokens: "100" };
    const [byok] = await source([BYOK_SPEND], [BYOK_USAGE, second]).readUsage("1 day");
    expect(byok.usage.extras.endpoint_name).toBe(BYOK_USAGE.endpoint_name);
    expect(byok.usage.extras.api_type).toBe("anthropic/v1/messages");
    for (const k of ["invocation_id", "request_id", "status_code"]) {
      expect(byok.usage.extras[k]).toBeUndefined();
    }
  });

  it("describe a single-request bucket the same way", async () => {
    // Otherwise status_code survives on quiet hours and vanishes on busy ones — the
    // same bucket shape reporting different fields depending on traffic.
    const [byok] = await source([BYOK_SPEND], [BYOK_USAGE]).readUsage("1 day");
    expect(byok.usage.extras.invocation_id).toBeUndefined();
    expect(byok.usage.extras.endpoint_name).toBe(BYOK_USAGE.endpoint_name);
  });
});

describe("DatabricksSource.fromEnv", () => {
  const KEYS = ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_WAREHOUSE_ID"];

  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("names every missing variable", () => {
    for (const k of KEYS) delete process.env[k];
    expect(() => DatabricksSource.fromEnv()).toThrow(/DATABRICKS_HOST.*DATABRICKS_WAREHOUSE_ID/);
  });

  it("trims a trailing slash off the host", () => {
    // Or every URL doubles its separator — Databricks 404s on `//api/2.0/...`.
    process.env.DATABRICKS_HOST = "https://dbc-x.cloud.databricks.com/";
    process.env.DATABRICKS_TOKEN = "dapi-x";
    process.env.DATABRICKS_WAREHOUSE_ID = "wh-1";
    expect(DatabricksSource.fromEnv().host).toBe("https://dbc-x.cloud.databricks.com");
  });
});

describe("Databricks reader — JSON string columns", () => {
  it("survive the round trip", async () => {
    // STRUCT/MAP columns arrive as JSON strings over the Statement Execution API. The
    // reader joins on the tag map, so it has to parse the same way the adapter does or
    // every BYOK row misses its token counts.
    const src = source(
      [{ ...BYOK_SPEND, request_tags: JSON.stringify({ lago_subscription: "sub_byok" }) }],
      [BYOK_USAGE],
    );
    const [byok] = await src.readUsage("1 day");
    expect(byok.usage.input).toBe(1825);
    expect(byok.subscription).toBe("sub_byok");
  });
});

// --------------------------------------------------------------------------
// Post-review hardening — each of these pins a bug found by code review
// --------------------------------------------------------------------------
describe("Databricks reader — review fixes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not let rows with no usable id collide", async () => {
    // `safeStr(a || b)` returned "" for a row whose ids were NULL, and also for one whose
    // id a driver handed back as a non-string. Every such row then shared one
    // `transaction_id`, so Lago billed the first and rejected the rest — silently.
    const a = { ...HOSTED, invocation_id: null, request_id: null, input_tokens: "7" };
    const b = { ...HOSTED, invocation_id: null, request_id: null, input_tokens: "9" };
    const rows = await source([], [a, b]).readUsage("1 day");
    expect(rows).toHaveLength(2);
    expect(rows[0].rowId).toBeTruthy();
    expect(rows[0].eventId).not.toBe(rows[1].eventId);

    // A non-string id must be used, not skipped into the fallback.
    const [row] = await source([], [{ ...HOSTED, invocation_id: 12345 }]).readUsage("1 day");
    expect(row.rowId).toBe("12345");
  });

  it("makes the id fallback deterministic so re-runs stay idempotent", async () => {
    const row = { ...HOSTED, invocation_id: null, request_id: null };
    const first = (await source([], [row]).readUsage("1 day"))[0].eventId;
    const second = (await source([], [row]).readUsage("1 day"))[0].eventId;
    expect(first).toBe(second);
  });

  it("reports BYOK tokens with no spend row instead of losing them", async () => {
    // external_model_spend lags ai_gateway.usage, so the newest hour has token rows whose
    // dollar row does not exist yet. The spend loop skips them (no dollars) and the hosted
    // loop skips them (not databricks), so they were billed by neither and counted by
    // nothing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await source([], [BYOK_USAGE]).readUsage("1 day");
    expect(rows).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no external_model_spend row yet"))).toBe(true);
  });

  it("converts a Date window to UTC", () => {
    // Kept in step with Python, which had to be fixed to convert rather than format local
    // wall time — otherwise the two repos read different windows from the same input.
    expect(intervalSql(new Date("2026-08-11T12:00:00.000Z"))).toBe("TIMESTAMP '2026-08-11 12:00:00'");
  });

  it("still buckets and reconciles when timestamps arrive as Date", async () => {
    // `@databricks/sql` returns TIMESTAMPs as Date. `safeStr` mapped those to "",
    // collapsing every hour into one join bucket — so each hourly spend event reported
    // the whole window's tokens — and dropping the `bucket` reconcile dimension.
    const spend = { ...BYOK_SPEND, bucket: new Date("2026-08-07T14:00:00.000Z") };
    const usageRow = { ...BYOK_USAGE, event_time: new Date("2026-08-07T14:22:03.000Z") };
    const [byok] = await source([spend], [usageRow]).readUsage("1 day");
    expect(byok.usage.input).toBe(1825);
    // ISO-8601 UTC, not `String(date)` locale text — see `stamp`.
    expect(byok.reconcileDimensions.bucket).toBe("2026-08-07T14:00:00.000Z");
  });

  it("skips a malformed usage_quantity instead of billing NaN", async () => {
    const rows = await source([{ ...BYOK_SPEND, usage_quantity: "NULL" }], [BYOK_USAGE]).readUsage("1 day");
    expect(rows).toEqual([]);
  });

  it("keys an empty tag map the same as a NULL one", async () => {
    // canonicalTags rendered `{}` as "[]" but NULL as "{}", so an untagged spend row never
    // joined its untagged usage rows — and untagged is the common case, so every untagged
    // BYOK event was emitted with all-zero token counts.
    const spend = { ...BYOK_SPEND, request_tags: null };
    const usageRow = { ...BYOK_USAGE, request_tags: "{}" };
    const [byok] = await source([spend], [usageRow]).readUsage("1 day");
    expect(byok.usage.input).toBe(1825);
  });

  it("polls a statement that is still running", async () => {
    // A statement still executing when `wait_timeout` elapses returns HTTP 200 with
    // `state: PENDING` — not an error.
    const pending = { statement_id: "s1", status: { state: "PENDING" } };
    const done = {
      statement_id: "s1",
      status: { state: "SUCCEEDED" },
      manifest: { schema: { columns: [{ name: "a" }] }, total_chunk_count: 1 },
      result: { data_array: [["1"]] },
    };
    let gets = 0;
    vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST")
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(pending) });
      gets += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(gets === 1 ? pending : done),
      });
    });
    const src = new DatabricksSource("https://x", "t", "w", { timeoutMs: 30_000 });
    await expect(src.query("SELECT 1")).resolves.toEqual([{ a: "1" }]);
    expect(gets).toBeGreaterThanOrEqual(2);
  });

  it("accepts already-read rows without querying again", async () => {
    // The demo read the window to print a summary and then handed the SOURCE to
    // backfillDatabricks, re-running both warehouse queries.
    const src = source([BYOK_SPEND], [HOSTED, BYOK_USAGE]);
    const rows = await src.readUsage("1 day");
    const queriesAfterRead = src.queries.length;

    const [sdk, rec] = sdkWithRecorder();
    const counts = await sdk.backfillDatabricks(rows, undefined, { defaultSubscription: "sub_x" });
    await drain(sdk);
    expect(counts).toEqual({ cost: 1, tokens: 1, skipped: 0 });
    expect(src.queries.length).toBe(queriesAfterRead);
    expect(rec.events.length).toBeGreaterThanOrEqual(3);
  });
});

// --------------------------------------------------------------------------
// Event time — a backfill runs long after the usage it bills
// --------------------------------------------------------------------------
function utc(...parts: number[]): number {
  return Date.UTC(parts[0], parts[1], parts[2], parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0) / 1000;
}

describe("Databricks reader — event time", () => {
  it("reads each kind's own time column", async () => {
    // A usage row's own instant; a spend row's hour START — the only instant certain
    // to sit inside the hour that row aggregates.
    const [spendRow, usageRow] = await source([BYOK_SPEND], [HOSTED]).readUsage("1 day");
    expect([spendRow.kind, usageRow.kind]).toEqual(["spend", "usage"]);
    expect(spendRow.occurredAt).toBe(utc(2026, 7, 7, 14, 0, 0));
    expect(usageRow.occurredAt).toBe(utc(2026, 7, 7, 14, 22, 3));
  });

  it("reads a Date column the same way", async () => {
    // `databricks-sql-connector` returns TIMESTAMPs as `Date`, the REST API as
    // ISO-8601 strings ending in "Z". Both are supported access paths, so both must
    // resolve to the same instant.
    const rows = await source(
      [{ ...BYOK_SPEND, bucket: new Date(Date.UTC(2026, 7, 7, 14, 0, 0)) }],
      [{ ...HOSTED, event_time: "2026-08-07T14:22:03.123Z" }],
    ).readUsage("1 day");
    expect(new Set(rows.map((r) => r.occurredAt))).toEqual(
      new Set([utc(2026, 7, 7, 14, 0, 0), utc(2026, 7, 7, 14, 22, 3)]),
    );
  });

  it("reads an offset-less stamp as UTC, not as local time", async () => {
    // `new Date("2026-08-07 14:22:03")` is LOCAL time in V8 where the Python port's
    // `fromisoformat` result is read as UTC — so without normalising first, the two
    // repos bill the same row hours apart on any machine that is not on UTC.
    const [row] = await source([], [HOSTED]).readUsage("1 day");
    expect(row.occurredAt).toBe(utc(2026, 7, 7, 14, 22, 3));
  });

  it("has no occurredAt for a row with no readable time", () => {
    // undefined leaves `emit()` stamping `now`, which is wrong but billed — better
    // than losing the row over a bad column.
    const rowWith = (eventTime: unknown) =>
      new DatabricksUsageRow(
        makeCanonicalUsage({ model: "m", provider: "databricks", api: "databricks_gateway" }),
        "sub",
        "r",
        "usage",
        undefined,
        "dbx",
        { event_time: eventTime },
      );
    for (const bad of [null, undefined, "", "not a timestamp"]) {
      expect(rowWith(bad).occurredAt).toBeUndefined();
    }
    // A readable column on the same shape of row must still resolve, so this cannot
    // pass merely because the property is absent.
    expect(rowWith("2026-08-07 14:22:03").occurredAt).toBe(utc(2026, 7, 7, 14, 22, 3));
  });

  it("backfill events carry the source row's time, not the run time", async () => {
    // Live-proven before the fix: 128 events off one window spanning 2026-08-06 to
    // 2026-08-11 all carried the run's own clock, billing historical usage into the
    // current period.
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillDatabricks(source([BYOK_SPEND], [HOSTED, BYOK_USAGE]), "1 day");
    await drain(sdk);

    const cost = rec.events.filter((e) => e.code === "llm_cost");
    const tokens = rec.events.filter((e) => e.code !== "llm_cost");
    expect(cost.length).toBeGreaterThan(0);
    expect(tokens.length).toBeGreaterThan(0);
    // The spend row's hour, and the hosted request's own second.
    expect(new Set(cost.map((e) => e.timestamp))).toEqual(new Set([utc(2026, 7, 7, 14, 0, 0)]));
    expect(new Set(tokens.map((e) => e.timestamp))).toEqual(new Set([utc(2026, 7, 7, 14, 22, 3)]));
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    expect(rec.events.every((e) => e.timestamp < dayAgo)).toBe(true);
  });
});
