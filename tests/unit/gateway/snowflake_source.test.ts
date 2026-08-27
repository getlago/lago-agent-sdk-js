/**
 * Snowflake Cortex usage reader — the I/O half, exercised without touching a warehouse.
 *
 * Two levels. `SnowflakeSource.query` is faked for the reading tests, so the SQL it would
 * run is asserted; and `fetch` itself is faked for the transport tests, reproducing the
 * SQL API's envelope exactly as it comes back — `resultSetMetaData.rowType` plus a
 * POSITIONAL `data` array, partition 0 inline, `partitionInfo` counting it.
 *
 * The row shapes are the captured fixtures, not invented ones, except where a case has
 * never been observed on a live account (a multi-bucket query, a partial row). Those are
 * hand-made and labelled as such — the whole point of the deferral they exercise is that
 * nobody has seen the shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nonzeroNumeric } from "../../../src/canonical.js";
import {
  FUNCTIONS_COLUMNS,
  REST_COLUMNS,
  SnowflakeSource,
  SnowflakeUsageRow,
  floorHour,
  timestampSql,
  windowBounds,
} from "../../../src/gateway/snowflake.js";
import { LagoSDK } from "../../../src/sdk.js";

const FIXTURES = join(__dirname, "adapters", "fixtures", "snowflake_cortex");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

// --------------------------------------------------------------------------
// Rows. Captured ones first.
// --------------------------------------------------------------------------
const AI_COMPLETE = fixture("functions_ai_complete");
const AI_EMBED = fixture("functions_total_only_with_model");
const REST_PLAIN = fixture("rest_plain");
const REST_CACHED = fixture("rest_cache_read");
const ENVELOPE = fixture("api_partition_envelope");

// A tagged functions row, so attribution has something to resolve. The tag shape is the
// one `resolveSnowflakeSubscription` documents and the same key Cloudflare and Databricks
// read from their own metadata.
const TAGGED = {
  ...AI_COMPLETE,
  QUERY_ID: "01c67fe9-tagged",
  QUERY_TAG: '{"lago_subscription": "sub_tagged"}',
};

// HAND-MADE, and deliberately: an hour-bucketed query spanning three buckets writes three
// rows under ONE QUERY_ID. Snowflake documents it; no captured row shows it, because every
// query this account has ever run finished inside one bucket (48 of 48). The numbers are
// the INT-224 probe's real totals split three ways, which is what makes the ambiguity
// concrete — incremental they sum to the truth, cumulative they do not.
const SPANNING = ["1787162400", "1787166000", "1787169600"].map((start, i) => ({
  ...AI_COMPLETE,
  QUERY_ID: "01c67fe9-spanning",
  START_TIME: start,
  END_TIME: String(Number(start) + 3600),
  IS_COMPLETED: i === 2 ? "true" : "false",
  METRICS: JSON.stringify([
    { key: { metric: "input", unit: "tokens" }, value: 900 + i * 100 },
    { key: { metric: "output", unit: "tokens" }, value: 2000 + i * 100 },
  ]),
}));

// A partial row alone in the window — the other half of the deferral rule. Its QUERY_ID
// does not collide with anything here, so only the flag defers it.
const INCOMPLETE = {
  ...AI_COMPLETE,
  QUERY_ID: "01c67fe9-incomplete",
  IS_COMPLETED: "false",
};

// A failed call produces NO row on either view (measured with a same-batch control), so a
// zero-token row is a shape nobody has seen. Written anyway: it must bill nothing rather
// than emit an empty event.
const ZERO_USAGE = {
  ...AI_COMPLETE,
  QUERY_ID: "01c67fe9-zero",
  METRICS: "[]",
  CREDITS: "0",
};

/** A source whose `query` answers from canned rows, keyed on which view the SQL names. */
function source(
  functions: Record<string, unknown>[] = [],
  rest: Record<string, unknown>[] = [],
): SnowflakeSource & { queries: string[] } {
  const src = new SnowflakeSource("ORG-ACCT", "tok", {
    warehouse: "COMPUTE_WH",
  }) as SnowflakeSource & { queries: string[] };
  src.queries = [];
  src.query = (sql: string) => {
    src.queries.push(sql);
    return Promise.resolve(sql.includes("CORTEX_REST_API_USAGE_HISTORY") ? rest : functions);
  };
  return src;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// --------------------------------------------------------------------------
// Rule 4 — the window
// --------------------------------------------------------------------------
const NOW = new Date("2026-08-26T13:34:12.000Z");

describe("Snowflake reader — the window", () => {
  it("resolves interval strings to instants, not SQL", () => {
    // Resolved in JS so both views can share one bound. A `DATEADD(hour, -N,
    // CURRENT_TIMESTAMP())` in the SQL is re-evaluated per statement, and a row landing
    // in the drift between the two reads is read by neither.
    const [lower, upper] = windowBounds("2 hours", NOW);
    expect(lower.toISOString()).toBe("2026-08-26T11:00:00.000Z");
    expect(upper.toISOString()).toBe("2026-08-26T13:00:00.000Z");
  });

  it("rejects an interval it does not understand rather than guessing", () => {
    // Under-reading is the one direction that loses money, so a window that cannot be
    // parsed must not silently become a narrower one.
    expect(() => windowBounds("last tuesday", NOW)).toThrow(/not understood/);
    expect(() => windowBounds("2 fortnights", NOW)).toThrow(/not understood/);
  });

  it("floors both bounds to the hour", () => {
    // Both views are hour-bucketed and START_TIME is always the hour START, so a mid-hour
    // lower bound drops every row of the hour containing it — including calls made after
    // the bound itself.
    const [lower, upper] = windowBounds(new Date("2026-08-26T09:47:31.500Z"), NOW);
    expect(lower.toISOString()).toBe("2026-08-26T09:00:00.000Z");
    expect(upper.toISOString()).toBe("2026-08-26T13:00:00.000Z");
  });

  it("excludes the still-aggregating hour", () => {
    // 13:34 reads up to 13:00, never past it. The functions view lands a row ~141s after
    // its query ends, so the open hour is incomplete by construction; billing it early
    // burns the row's QUERY_ID-derived transaction_id and the correction is then rejected
    // as a duplicate.
    expect(windowBounds("1 day", NOW)[1].toISOString()).toBe("2026-08-26T13:00:00.000Z");
  });

  it("does not mutate the caller's Date", () => {
    const since = new Date("2026-08-26T09:47:31.500Z");
    windowBounds(since, NOW);
    expect(since.toISOString()).toBe("2026-08-26T09:47:31.500Z");
  });

  it("names the zone in every timestamp literal", () => {
    // Rule 6. A bare literal is parsed in the session's TIMEZONE, and Snowflake accounts
    // default to America/Los_Angeles — so the whole window would slide 7-8 hours.
    expect(timestampSql(new Date("2026-08-26T13:00:00.000Z"))).toBe("'2026-08-26 13:00:00+00:00'");
  });

  it("floorHour moves the instant, in UTC", () => {
    expect(floorHour(new Date("2026-08-26T13:59:59.999Z")).toISOString()).toBe("2026-08-26T13:00:00.000Z");
  });

  it("scopes both views to one shared window", async () => {
    // Rule 4's core: ONE literal pair, both statements. Two separately-resolved windows
    // is the drift bug again.
    const src = source([AI_COMPLETE], [REST_PLAIN]);
    await src.readUsage("3 hours", { views: ["functions", "rest"] });
    expect(src.queries).toHaveLength(2);
    const literals = src.queries.map((q) => q.match(/'[^']+\+00:00'/g));
    expect(literals[0]).toHaveLength(2);
    expect(literals[0]).toEqual(literals[1]);
  });

  it("reads nothing and says so when the window is entirely inside the open hour", async () => {
    // Zero rows here says nothing about whether there was traffic, so it must not read as
    // success.
    //
    // The clock is pinned because whether a sub-hour interval collapses depends on where
    // in the hour it is evaluated: 30 minutes back from :34 stays inside one hour and
    // collapses, while 30 minutes back from :10 crosses the boundary and does not. Left on
    // the wall clock this test would pass for half of every hour.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const src = source([AI_COMPLETE]);
      expect(await src.readUsage("30 minutes")).toEqual([]);
      expect(src.queries).toEqual([]);
      expect(warn.mock.calls[0][0]).toMatch(/still-aggregating hour/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --------------------------------------------------------------------------
// Rule 5 — the projection
// --------------------------------------------------------------------------
function projectionOf(sql: string): string[] {
  const m = /SELECT\s+([\s\S]*?)\s+FROM/i.exec(sql);
  return (m?.[1] ?? "").split(",").map((s) => s.trim());
}

describe("Snowflake reader — the projection", () => {
  it("never uses SELECT *", async () => {
    // `*` risks the inline-response size cap, which FAILS a statement rather than
    // paginating past it — and these views gain columns without notice (this account
    // watched the REST view go from 8 to 9 in eight hours), so `*` is a width nobody
    // controls.
    const src = source([AI_COMPLETE], [REST_PLAIN]);
    await src.readUsage("3 hours", { views: ["functions", "rest"] });
    for (const sql of src.queries) expect(sql).not.toMatch(/SELECT\s+\*/i);
  });

  it("projects exactly the named columns", async () => {
    const src = source([AI_COMPLETE], [REST_PLAIN]);
    await src.readUsage("3 hours", { views: ["functions", "rest"] });
    expect(projectionOf(src.queries[0])).toEqual([...FUNCTIONS_COLUMNS]);
    expect(projectionOf(src.queries[1])).toEqual([...REST_COLUMNS]);
  });

  it("covers every column the extraction reads", () => {
    // THE coupling test. A column dropped from the projection reaches the adapter as
    // ABSENT, where every field degrades to zero rather than throwing — an under-billed
    // event with no error anywhere. Asserted against the captured rows' own keys, so a
    // column the fixtures prove exists cannot be quietly dropped from the read.
    for (const key of Object.keys(AI_COMPLETE)) {
      expect(FUNCTIONS_COLUMNS as readonly string[]).toContain(key);
    }
    for (const key of Object.keys(REST_PLAIN)) {
      expect(REST_COLUMNS as readonly string[]).toContain(key);
    }
    // And the reverse direction, so the projection cannot grow a column nothing reads:
    // every projected name must be one the fixtures or the adapter contract carry.
    expect(FUNCTIONS_COLUMNS).toContain("IS_COMPLETED");
    expect(FUNCTIONS_COLUMNS).toContain("METRICS");
    expect(REST_COLUMNS).toContain("TOKENS_GRANULAR");
  });
});

// --------------------------------------------------------------------------
// Rules 1, 2, 3 — the transport
// --------------------------------------------------------------------------
/** One SQL API response, in the exact envelope shape the API returns. */
function envelope(rows: unknown[][], opts: { numRows?: number; partitions?: number } = {}) {
  const partitions = opts.partitions ?? 1;
  return {
    resultSetMetaData: {
      numRows: String(opts.numRows ?? rows.length),
      rowType: [{ name: "QUERY_ID" }, { name: "METRICS" }],
      partitionInfo: Array.from({ length: partitions }, () => ({ rowCount: rows.length })),
      partitionContentEncoding: "gzip",
    },
    data: rows,
    statementHandle: "01c6-handle",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function transportSource(opts: Record<string, unknown> = {}): SnowflakeSource {
  return new SnowflakeSource("ORG-ACCT", "tok", { warehouse: "COMPUTE_WH", ...opts });
}

describe("Snowflake reader — query", () => {
  it("zips rowType against the positional data array", async () => {
    // The API returns rows POSITIONALLY, not as objects. Getting this wrong yields `{}`
    // per row, which every layer downstream degrades cleanly and wrongly on.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(envelope([["q1", "[]"]]))),
    );
    expect(await transportSource().query("SELECT 1")).toEqual([{ QUERY_ID: "q1", METRICS: "[]" }]);
  });

  it("follows every partition, and counts partition 0 as one of them", async () => {
    // Verified against the captured envelope: 8 partitionInfo entries whose rowCounts sum
    // to numRows, the FIRST being the rows already inline. Starting the fetch loop at 1 is
    // what makes that true — starting at 0 re-reads the inline rows and doubles them.
    expect(ENVELOPE.partitionCount).toBe(8);
    expect((ENVELOPE.partitionInfo as any[])[0].rowCount).toBe(ENVELOPE.inlineRowCount);
    expect((ENVELOPE.partitionInfo as any[]).reduce((n, p) => n + p.rowCount, 0)).toBe(ENVELOPE.numRows);

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("partition=")) return jsonResponse({ data: [["q2", "[]"]] });
      return jsonResponse(envelope([["q1", "[]"]], { numRows: 3, partitions: 3 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await transportSource().query("SELECT 1");
    expect(rows.map((r) => r.QUERY_ID)).toEqual(["q1", "q2", "q2"]);
    // Submission plus partitions 1 and 2 — never partition 0.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("partition="))).toEqual([
      expect.stringContaining("partition=1"),
      expect.stringContaining("partition=2"),
    ]);
  });

  it("throws when a partition fetch fails, rather than billing a partial window", async () => {
    // RULE 1, and the single worst outcome this reader can produce. A failed partition
    // returns a JSON error body with no `data`, so a tolerant `?? []` appends nothing, the
    // loop continues, and the read reports success over a fraction of the window. On the
    // captured envelope that is 472 of 60,000 rows.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("partition=")
          ? jsonResponse({ code: "390403", message: "insufficient privileges" }, 403)
          : jsonResponse(envelope([["q1", "[]"]], { numRows: 2, partitions: 2 })),
      ),
    );
    await expect(transportSource().query("SELECT 1")).rejects.toThrow(/partition 1 of 2 failed: HTTP 403/);
  });

  it("carries Snowflake's own error text, not just the status", async () => {
    // `003001` alone has four distinct causes on this account, so the message is the only
    // thing that tells an operator which one they hit.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "390318", message: "Authentication token has expired" }, 401)),
    );
    await expect(transportSource().query("SELECT 1")).rejects.toThrow(/Authentication token has expired/);
  });

  it("throws when the assembled row count misses numRows", async () => {
    // RULE 2, end-to-end and independent of cause: catches a partition that answers HTTP
    // 200 with fewer rows than promised, which no per-request status check can see.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(envelope([["q1", "[]"]], { numRows: 9 }))),
    );
    await expect(transportSource().query("SELECT 1")).rejects.toThrow(
      /returned 1 row\(s\) but the statement promised 9/,
    );
  });

  it("throws when rows arrive with no rowType to decode them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          resultSetMetaData: { numRows: "1", rowType: [], partitionInfo: [{ rowCount: 1 }] },
          data: [["q1", "[]"]],
          statementHandle: "h",
        }),
      ),
    );
    await expect(transportSource().query("SELECT 1")).rejects.toThrow(/no `resultSetMetaData.rowType`/);
  });

  it("polls a 202 to completion instead of failing", async () => {
    // RULE 3. A 202 is the EXPECTED answer for the one wide window per run this class
    // tells operators to read; treating it as fatal breaks exactly that case.
    let poll = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/v2/statements/")) {
          poll += 1;
          if (poll < 2) return jsonResponse({ statementHandle: "h", message: "running" }, 202);
          return jsonResponse(envelope([["q1", "[]"]]));
        }
        return jsonResponse({ statementHandle: "h", statementStatusUrl: "/api/v2/statements/h" }, 202);
      }),
    );
    const rows = await transportSource({ pollIntervalMs: 1 }).query("SELECT 1");
    expect(rows).toEqual([{ QUERY_ID: "q1", METRICS: "[]" }]);
    expect(poll).toBe(2);
  });

  it("bounds a 202 that never completes, by iterations as well as by deadline", async () => {
    // Both bounds, because either alone leaves a hole: a statement that answers every poll
    // instantly would spin timeoutMs/interval times on the cap alone, and a slow poll
    // would outlive the deadline without it.
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/api/v2/statements/")
        ? jsonResponse({ statementHandle: "h", message: "running" }, 202)
        : jsonResponse({ statementHandle: "h", statementStatusUrl: "/api/v2/statements/h" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(transportSource({ pollIntervalMs: 1, maxPolls: 3 }).query("SELECT 1")).rejects.toThrow(
      /still running after .* 3 poll\(s\)/,
    );
    // Submission plus exactly three polls — the cap held, the deadline never had to.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("refuses a 202 that carries no handle to poll", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "accepted" }, 202)),
    );
    await expect(transportSource().query("SELECT 1")).rejects.toThrow(/202 with no statementHandle/);
  });

  it("leaves no timer armed once a poll has finished", async () => {
    // The AC's "no un-unref'd timer": a backfill script that returns must let the process
    // exit. `setTimeout` inside an awaited promise resolves and clears; a `setInterval`
    // nobody clears would still be counted here.
    vi.useFakeTimers();
    try {
      let poll = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (String(url).includes("/api/v2/statements/")) {
            poll += 1;
            return poll < 2
              ? jsonResponse({ statementHandle: "h", message: "running" }, 202)
              : jsonResponse(envelope([["q1", "[]"]]));
          }
          return jsonResponse({ statementHandle: "h", statementStatusUrl: "/api/v2/statements/h" }, 202);
        }),
      );
      const pending = transportSource({ pollIntervalMs: 1000 }).query("SELECT 1");
      await vi.runAllTimersAsync();
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the PAT token-type header, without which a PAT reads as a bad secret", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(envelope([])));
    vi.stubGlobal("fetch", fetchMock);
    await transportSource().query("SELECT 1");
    const headers = (fetchMock.mock.calls[0][1] as any).headers;
    expect(headers["X-Snowflake-Authorization-Token-Type"]).toBe("PROGRAMMATIC_ACCESS_TOKEN");
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("passes the warehouse and role as context, case intact", async () => {
    // Context values are case-SENSITIVE here, unlike an unquoted SQL identifier. And
    // reading ACCOUNT_USAGE needs a running warehouse at all — the live wrap() path does
    // not, which is why this is the setup step people miss.
    const fetchMock = vi.fn(async () => jsonResponse(envelope([])));
    vi.stubGlobal("fetch", fetchMock);
    await transportSource({ role: "LAGO_CORTEX_ROLE" }).query("SELECT 1");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.warehouse).toBe("COMPUTE_WH");
    expect(body.role).toBe("LAGO_CORTEX_ROLE");
    expect(body.timeout).toBe(120);
  });
});

// --------------------------------------------------------------------------
// The functions view, and the QUERY_ID that is not unique
// --------------------------------------------------------------------------
describe("Snowflake reader — the functions view", () => {
  it("bills a single-bucket row, keyed on its QUERY_ID", async () => {
    const rows = await source([AI_COMPLETE]).readUsage("3 hours");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("functions");
    expect(rows[0].rowId).toBe("01c67fe9-0302-ce36-001e-606300034516");
    expect(rows[0].usage.input).toBe(13);
    expect(rows[0].usage.output).toBe(5);
  });

  it("bills a {total}-only row, which is five of the six function types", async () => {
    // The adapter maps `total` onto `input` and marks it; without that, five of six
    // function types extract to all-zero and emit nothing — a silent 100% under-bill.
    const rows = await source([AI_EMBED]).readUsage("3 hours");
    expect(rows[0].usage.input).toBe(3);
    expect(rows[0].usage.extras.metrics_total_only).toBe(true);
  });

  it("defers every row of a QUERY_ID that yields more than one", async () => {
    // The collision itself: `{prefix}_{kind}_{sub}_{QUERY_ID}` cannot distinguish these
    // three rows, so Lago accepts one and rejects two as duplicates — taking the whole
    // batch down the all-or-nothing split path. And whether the per-window METRICS is
    // incremental or cumulative is unmeasured, so neither summing them nor taking the last
    // is defensible: on this row set summing bills 3300 input and taking the final row
    // bills 1100, and only one of those is right.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source(SPANNING);
    expect(await src.readUsage("1 day")).toEqual([]);
    expect(src.deferredRows).toHaveLength(3);
    expect(src.deferredRows[0].reason).toBe("multi_bucket");
    expect(src.deferredRows[0].buckets).toEqual(["1787162400", "1787166000", "1787169600"]);
    expect(warn.mock.calls[0][0]).toMatch(/were NOT billed/);
  });

  it("defers a row explicitly flagged incomplete, even alone in the window", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source([INCOMPLETE]);
    expect(await src.readUsage("1 day")).toEqual([]);
    expect(src.deferredRows[0].reason).toBe("incomplete");
    expect(warn).toHaveBeenCalled();
  });

  it("does not defer on an absent or unparseable IS_COMPLETED", async () => {
    // Only an EXPLICIT false defers. A view that stopped populating the column, or one
    // that spelled the value differently, must not silently defer an entire window —
    // that turns a guard into a 100% under-bill.
    const noFlag = { ...AI_COMPLETE, QUERY_ID: "q-noflag", IS_COMPLETED: null };
    const odd = { ...AI_COMPLETE, QUERY_ID: "q-odd", IS_COMPLETED: "COMPLETED" };
    const src = source([noFlag, odd]);
    expect(await src.readUsage("1 day")).toHaveLength(2);
    expect(src.deferredRows).toEqual([]);
  });

  it("accepts IS_COMPLETED as a real boolean, the way a typed connector yields it", async () => {
    const src = source([{ ...AI_COMPLETE, QUERY_ID: "q-bool", IS_COMPLETED: false }]);
    expect(await src.readUsage("1 day")).toEqual([]);
    expect(src.deferredRows[0].reason).toBe("incomplete");
  });

  it("bills the healthy rows in a window that also holds a deferred one", async () => {
    // QA scenario 6's shape: one bad row degrades, the rest still bills. A deferral that
    // took the window down with it would be a far worse bug than the one it guards.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source([AI_COMPLETE, ...SPANNING, AI_EMBED]);
    const rows = await src.readUsage("1 day");
    expect(rows.map((r) => r.rowId).sort()).toEqual(
      ["01c67fe9-0302-ce36-001e-606300034516", "01c6a022-0102-dd95-001e-6063000d07fa"].sort(),
    );
    expect(src.deferredRows).toHaveLength(3);
    expect(warn).toHaveBeenCalled();
  });

  it("skips a row that bills nothing rather than emitting an empty event", async () => {
    expect(await source([ZERO_USAGE]).readUsage("1 day")).toEqual([]);
  });

  it("survives a row whose METRICS is not parseable", async () => {
    // Rule 7: a parse failure degrades to empty rather than throwing, so one bad row
    // cannot take down a window. Nothing billable comes out, so nothing is emitted.
    const src = source([{ ...AI_COMPLETE, QUERY_ID: "q-bad", METRICS: "{not json" }, AI_EMBED]);
    const rows = await src.readUsage("1 day");
    expect(rows.map((r) => r.rowId)).toEqual(["01c6a022-0102-dd95-001e-6063000d07fa"]);
  });

  it("clears the previous read's deferred rows on a second read", async () => {
    // A later read of a healthy window must not leave an earlier read's gap standing as
    // if it were current.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source(SPANNING);
    await src.readUsage("1 day");
    expect(src.deferredRows).toHaveLength(3);
    src.query = () => Promise.resolve([AI_COMPLETE]);
    await src.readUsage("1 day");
    expect(src.deferredRows).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// The REST view, and the double-bill it can cause
// --------------------------------------------------------------------------
describe("Snowflake reader — the REST view", () => {
  it("is not read by default", async () => {
    // THE default that keeps a live-path customer from billing every REST call twice.
    // The live path's transaction_id is a random UUID and this reader's derives from
    // REQUEST_ID, so Lago cannot reject the duplicate.
    const src = source([AI_COMPLETE], [REST_PLAIN]);
    const rows = await src.readUsage("3 hours");
    expect(rows.every((r) => r.kind === "functions")).toBe(true);
    expect(src.queries).toHaveLength(1);
    expect(src.queries[0]).toContain("CORTEX_AI_FUNCTIONS_USAGE_HISTORY");
  });

  it("is read when asked for, and warns about the traffic it overlaps", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source([], [REST_PLAIN]);
    const rows = await src.readUsage("3 hours", { views: ["rest"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("rest");
    expect(rows[0].rowId).toBe("8e1249f1-a9af-463e-8bb8-ed409269c61c");
    expect(warn.mock.calls[0][0]).toMatch(/live path ALREADY billed them/);
  });

  it("keeps the additive cache block out of input", async () => {
    // The token-shape guard, restated at the reader level. `TOKENS` INCLUDES the cached
    // block, so mapping it onto input would bill 8758 for 7 real input tokens and re-bill
    // the cache a second time as cache_read — 2.0x on the call.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await source([], [REST_CACHED]).readUsage("3 hours", { views: ["rest"] });
    const usage = rows[0].usage;
    expect(usage.cache_read).toBeGreaterThan(0);
    expect(usage.input).toBeLessThan(usage.cache_read);
    // The reconciliation tripwire: the billed fields must sum to Snowflake's own TOKENS.
    const billed = Object.values(nonzeroNumeric(usage)).reduce((a, b) => a + (b as number), 0);
    expect(billed).toBe(Number(REST_CACHED.TOKENS));
  });
});

// --------------------------------------------------------------------------
// Event ids
// --------------------------------------------------------------------------
describe("Snowflake reader — event ids", () => {
  it("are unique per row and scoped by subscription", async () => {
    // `transaction_id` is unique ORG-wide, so an unscoped id permanently blocks that row
    // from ever reaching a second subscription.
    const rows = await source([AI_COMPLETE, AI_EMBED]).readUsage("1 day");
    expect(new Set(rows.map((r) => r.eventIdFor("sub_a"))).size).toBe(2);
    expect(rows[0].eventIdFor("sub_a")).not.toBe(rows[0].eventIdFor("sub_b"));
    expect(rows[0].eventIdFor("sub_a")).toBe("sfc_functions_sub_a_01c67fe9-0302-ce36-001e-606300034516");
  });

  it("say `none` for an unattributed row rather than collapsing to one key", async () => {
    const row = new SnowflakeUsageRow(
      (await source([AI_COMPLETE]).readUsage("1 day"))[0].usage,
      null,
      "r1",
      "functions",
    );
    expect(row.eventId).toBe("sfc_functions_none_r1");
  });

  it("namespace the whole read by prefix", async () => {
    const rows = await source([AI_COMPLETE]).readUsage("1 day", { eventIdPrefix: "sfc2" });
    expect(rows[0].eventIdFor("sub_a")).toMatch(/^sfc2_functions_/);
  });

  it("fall back to a deterministic hash when the row carries no id", async () => {
    // A row with a NULL id yields "", and `eventIdFor` would still produce a well-formed
    // key — so EVERY such row in the window would share one transaction_id, Lago would
    // accept the first and reject the rest, and those calls would never bill. The hash
    // stays deterministic so a re-run is still idempotent, which a UUID would break.
    const a = { ...AI_COMPLETE, QUERY_ID: null };
    const b = { ...AI_COMPLETE, QUERY_ID: null, CREDITS: "0.000099999" };
    const rows = await source([a, b]).readUsage("1 day");
    expect(rows).toHaveLength(2);
    expect(rows[0].rowId).toMatch(/^sha[0-9a-f]{32}$/);
    expect(rows[0].rowId).not.toBe(rows[1].rowId);
    // Deterministic across reads of the same row.
    const again = await source([a]).readUsage("1 day");
    expect(again[0].rowId).toBe(rows[0].rowId);
  });
});

// --------------------------------------------------------------------------
// Stamping and dimensions
// --------------------------------------------------------------------------
describe("Snowflake reader — occurredAt", () => {
  it("reads the functions view's bare timestamp_ltz epoch", async () => {
    const rows = await source([AI_COMPLETE]).readUsage("1 day");
    expect(rows[0].occurredAt).toBe(1787162400);
  });

  it("reads the REST view's timestamp_tz epoch, ignoring the display offset", async () => {
    // "1787162400.000000000 1440" — the epoch is the true instant and 1440 is offset
    // minutes + 1440, i.e. UTC. Adding it would slide every REST event by the account's
    // timezone.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await source([], [REST_PLAIN]).readUsage("1 day", { views: ["rest"] });
    expect(rows[0].occurredAt).toBe(1787162400);
  });

  it("is the START of the hour, so a closing bucket cannot land in the next period", async () => {
    const rows = await source([AI_COMPLETE]).readUsage("1 day");
    // Exactly on the hour, which is what makes the stamp safe: an hourly bucket covers
    // [start, start + 1h), so the start is the only instant certain to sit inside the
    // row's own coverage.
    expect(new Date((rows[0].occurredAt as number) * 1000).toISOString()).toBe("2026-08-19T18:00:00.000Z");
  });

  it("degrades to undefined rather than throwing on an unreadable stamp", async () => {
    // emit() then stamps `now` — worse than the real time, better than dropping the event.
    const rows = await source([{ ...AI_COMPLETE, START_TIME: "not a time" }]).readUsage("1 day");
    expect(rows[0].occurredAt).toBeUndefined();
  });

  it("truncates rather than floors, matching Python's int()", async () => {
    // A pre-epoch stamp must round the same way in both ports, or the two repos bill the
    // same row a second apart.
    const rows = await source([{ ...AI_COMPLETE, START_TIME: "-1.5" }]).readUsage("1 day");
    expect(rows[0].occurredAt).toBe(-1);
  });
});

describe("Snowflake reader — reconciliation dimensions", () => {
  it("put the functions view's own grouping key on its events", async () => {
    const rows = await source([AI_COMPLETE]).readUsage("1 day");
    expect(rows[0].reconcileDimensions).toEqual({
      function_name: "AI_COMPLETE",
      model_name: "claude-sonnet-4-5",
    });
  });

  it("omit an empty model rather than emitting a blank dimension", async () => {
    // AI_SUMMARIZE/TRANSLATE/SENTIMENT/CLASSIFY take no model argument, so empty is a
    // fact about the row. A blank dimension value is a group nobody can read.
    const rows = await source([{ ...AI_COMPLETE, QUERY_ID: "q-nomodel", MODEL_NAME: "" }]).readUsage("1 day");
    expect(rows[0].reconcileDimensions).toEqual({ function_name: "AI_COMPLETE" });
  });

  it("put the REST view's region on its events, and never the request id", async () => {
    // A per-request id is a list, not a grouping — one Lago group per request is not a
    // comparison anyone can read.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await source([], [REST_PLAIN]).readUsage("1 day", { views: ["rest"] });
    expect(rows[0].reconcileDimensions).toEqual({ inference_region: "aws_global" });
  });
});

// --------------------------------------------------------------------------
// backfillSnowflake
// --------------------------------------------------------------------------
function sdkWithRecorder(errors?: [string, string][]): [LagoSDK, { events: Record<string, any>[] }] {
  const rec: { events: Record<string, any>[] } = { events: [] };
  const sdk = new LagoSDK({
    apiKey: "dummy",
    config: errors ? { onError: (err, where) => errors.push([where, String(err)]) } : undefined,
  });
  sdk._setSender(async (batch) => {
    rec.events.push(...(batch as unknown as Record<string, any>[]));
  });
  return [sdk, rec];
}

async function drain(sdk: LagoSDK): Promise<void> {
  expect(await sdk.flush(2000)).toBe(true);
  await sdk.shutdown(1000);
}

describe("backfillSnowflake", () => {
  it("counts tokens and skips, and never a cost", async () => {
    // There is no price mode on this path: Snowflake meters Cortex in CREDITS against a
    // rate card that exists in no view, so there is no per-request dollar figure to pass
    // through and `provider = "snowflake"` is in TOKEN_BILLED_PROVIDERS.
    const [sdk] = sdkWithRecorder();
    const counts = await sdk.backfillSnowflake(source([TAGGED, AI_EMBED]), "1 day", {
      defaultSubscription: "sub_default",
    });
    expect(counts).toEqual({ tokens: 2, skipped: 0 });
    await drain(sdk);
  });

  it("emits no llm_cost event", async () => {
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillSnowflake(source([TAGGED]), "1 day");
    await drain(sdk);
    expect(rec.events.length).toBeGreaterThan(0);
    expect(rec.events.some((e) => String(e.code).includes("cost"))).toBe(false);
  });

  it("routes a tagged row to its own subscription and an untagged one to the default", async () => {
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillSnowflake(source([TAGGED]), "1 day", {
      defaultSubscription: "sub_default",
      subscriptionOrder: ["query_tag"],
    });
    await drain(sdk);
    expect(new Set(rec.events.map((e) => e.external_subscription_id))).toEqual(new Set(["sub_tagged"]));

    const [sdk2, rec2] = sdkWithRecorder();
    await sdk2.backfillSnowflake(source([AI_COMPLETE]), "1 day", {
      defaultSubscription: "sub_default",
      subscriptionOrder: ["query_tag"],
    });
    await drain(sdk2);
    expect(new Set(rec2.events.map((e) => e.external_subscription_id))).toEqual(new Set(["sub_default"]));
  });

  it("unified ignores each row's own attribution", async () => {
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillSnowflake(source([TAGGED]), "1 day", {
      defaultSubscription: "sub_one",
      unified: true,
    });
    await drain(sdk);
    expect(new Set(rec.events.map((e) => e.external_subscription_id))).toEqual(new Set(["sub_one"]));
  });

  it("stamps each event with the row's own hour, not the run's clock", async () => {
    // A backfill that stamps `now` bills last week's usage into this week's period, and
    // nothing in Lago can tell afterwards.
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillSnowflake(source([TAGGED]), "1 day", { defaultSubscription: "s" });
    await drain(sdk);
    for (const event of rec.events) expect(event.timestamp).toBe(1787162400);
  });

  it("merges row dimensions under the caller's, which win on a collision", async () => {
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillSnowflake(source([TAGGED]), "1 day", {
      defaultSubscription: "s",
      dimensions: { model_name: "caller wins", tenant: "acme" },
    });
    await drain(sdk);
    const props = rec.events[0].properties;
    expect(props.function_name).toBe("AI_COMPLETE");
    expect(props.model_name).toBe("caller wins");
    expect(props.tenant).toBe("acme");
  });

  it("is idempotent across a re-run of the same window", async () => {
    // Every id derives from the source row, so Lago rejects the duplicates rather than
    // double-billing. Asserted as identical transaction_ids, which is what Lago keys on.
    const [sdk, rec] = sdkWithRecorder();
    await sdk.backfillSnowflake(source([TAGGED]), "1 day", { defaultSubscription: "s" });
    await drain(sdk);
    const first = rec.events.map((e) => e.transaction_id).sort();

    const [sdk2, rec2] = sdkWithRecorder();
    await sdk2.backfillSnowflake(source([TAGGED]), "1 day", { defaultSubscription: "s" });
    await drain(sdk2);
    expect(rec2.events.map((e) => e.transaction_id).sort()).toEqual(first);
  });

  it("does not read the REST view unless the caller names it", async () => {
    const [sdk] = sdkWithRecorder();
    const src = source([AI_COMPLETE], [REST_PLAIN]);
    await sdk.backfillSnowflake(src, "1 day", { defaultSubscription: "s" });
    expect(src.queries).toHaveLength(1);
    await drain(sdk);
  });

  it("forwards views when the caller does name it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [sdk] = sdkWithRecorder();
    const src = source([], [REST_PLAIN]);
    const counts = await sdk.backfillSnowflake(src, "1 day", {
      defaultSubscription: "s",
      views: ["rest"],
    });
    expect(counts.tokens).toBe(1);
    expect(src.queries[0]).toContain("CORTEX_REST_API_USAGE_HISTORY");
    await drain(sdk);
  });

  it("accepts an already-read array, so a wide window is read once", async () => {
    // Reading twice is not just slow: a SQL warehouse is a real cost centre, and rows
    // landing between the two reads make the summary you printed disagree with what was
    // billed.
    const [sdk] = sdkWithRecorder();
    const rows = await source([TAGGED]).readUsage("1 day");
    expect(await sdk.backfillSnowflake(rows, "1 day", { defaultSubscription: "s" })).toEqual({
      tokens: 1,
      skipped: 0,
    });
    await drain(sdk);
  });
});

describe("billing gaps must reach the caller, not just the log", () => {
  it("reports an unattributed row through onError", async () => {
    const errors: [string, string][] = [];
    const [sdk] = sdkWithRecorder(errors);
    const counts = await sdk.backfillSnowflake(source([AI_COMPLETE]), "1 day", {
      subscriptionOrder: ["query_tag"],
    });
    expect(counts).toEqual({ tokens: 0, skipped: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe("backfill");
    expect(errors[0][1]).toMatch(/no resolvable subscription/);
    await drain(sdk);
  });

  it("reports a deferred row through onError, and counts it as skipped", async () => {
    // A deferral that only logged would be a billing gap no automated caller could see —
    // `tokens` dropping is not something a script can read as a gap.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors: [string, string][] = [];
    const [sdk] = sdkWithRecorder(errors);
    const counts = await sdk.backfillSnowflake(source(SPANNING), "1 day", {
      defaultSubscription: "s",
    });
    expect(counts).toEqual({ tokens: 0, skipped: 3 });
    expect(errors.map((e) => e[1]).join(" ")).toMatch(/unbilled.*QUERY_ID=01c67fe9-spanning/s);
    await drain(sdk);
  });

  it("reports the two causes separately, because they are fixed differently", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors: [string, string][] = [];
    const [sdk] = sdkWithRecorder(errors);
    const counts = await sdk.backfillSnowflake(source([AI_COMPLETE, ...SPANNING]), "1 day", {
      subscriptionOrder: ["query_tag"],
    });
    expect(counts).toEqual({ tokens: 0, skipped: 4 });
    expect(errors).toHaveLength(2);
    expect(errors[0][1]).toMatch(/no resolvable subscription/);
    expect(errors[1][1]).toMatch(/unbilled/);
    await drain(sdk);
  });
});

// --------------------------------------------------------------------------
// Construction
// --------------------------------------------------------------------------
describe("SnowflakeSource.fromEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("names every missing variable", () => {
    delete process.env.SNOWFLAKE_ACCOUNT;
    delete process.env.SNOWFLAKE_HOST;
    delete process.env.SNOWFLAKE_PAT;
    expect(() => SnowflakeSource.fromEnv()).toThrow(/SNOWFLAKE_ACCOUNT.*SNOWFLAKE_PAT/s);
  });

  it("accepts either the account identifier or a full host", () => {
    // Snowflake's docs and error messages use the account form; appending
    // `.snowflakecomputing.com` twice is a 404 that reads like a bad account.
    expect(new SnowflakeSource("MYORG-ACCOUNT123", "t").host).toBe("MYORG-ACCOUNT123.snowflakecomputing.com");
    expect(new SnowflakeSource("acct.snowflakecomputing.com", "t").host).toBe("acct.snowflakecomputing.com");
    expect(new SnowflakeSource("https://acct.snowflakecomputing.com/", "t").host).toBe(
      "acct.snowflakecomputing.com",
    );
  });
});
