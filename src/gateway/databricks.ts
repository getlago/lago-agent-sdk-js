/**
 * Databricks AI Gateway usage reader — the I/O half of the connector.
 *
 * `gateway/adapters/databricks_gateway.ts` stays a pure function with no I/O. This
 * module is its sibling: it does the reading, and it exists because reading usage
 * out of Databricks is genuinely hard in a way Cloudflare's is not.
 *
 * Cloudflare is one paginated GET, about twelve lines. Databricks needs a SQL
 * warehouse, the Statement Execution API, columnar-to-object zipping, chunked result
 * fetching, and TWO different tables whose rows must not be billed twice. Hand-rolled
 * that is ~100 lines in which several money-losing mistakes are easy:
 *
 *   * **Silent truncation.** The Statement Execution API returns only chunk 0 inline;
 *     `manifest.total_chunk_count` can be higher and the rest need separate fetches.
 *     A naive reader works on a small window and quietly bills a fraction of a large
 *     one, with no error.
 *   * **Double billing.** A BYOK call appears in BOTH `ai_gateway.usage` (tokens) and
 *     `ai_gateway.external_model_spend` (USD). Bill both and you charge twice.
 *   * **Unscoped idempotency keys.** `transaction_id` is unique account-wide, so an
 *     unscoped row id silently blocks that row from ever reaching a second
 *     subscription.
 *
 * Deliberately NOT here: scheduler, cursor store, credential store. You pass an
 * explicit window and this returns what it finds; it does not remember where it got
 * to. That is the poller, and it stays a separate concern — as the Cloudflare
 * connector's changelog already states.
 *
 * Uses the global `fetch()`, so this adds nothing to the install.
 */

import { createHash } from "node:crypto";

import { type CanonicalUsage, NUMERIC_FIELDS, makeCanonicalUsage, nonzeroNumeric } from "../canonical.js";
import {
  extractDatabricksLog,
  resolveDatabricksSubscription,
  safeStr,
} from "./adapters/databricks_gateway.js";

const STATEMENTS_PATH = "/api/2.0/sql/statements";

// `since` as an interval string is interpolated into SQL, so it is validated strictly
// rather than escaped — only a bare count plus a unit is ever accepted.
const INTERVAL_RE = /^\s*(\d{1,5})\s+(second|minute|hour|day|week)s?\s*$/i;

/**
 * One billable row, already shaped for `emit()`.
 *
 * `usdCost` is set only for BYOK rows, where Databricks meters the provider cost
 * itself in `external_model_spend`. Hosted rows leave it undefined: Databricks bills
 * those in DBUs against a rate card that exists in no system table, so there is no
 * per-request dollar figure to pass through and they bill as token counts.
 */
export class DatabricksUsageRow {
  constructor(
    public usage: CanonicalUsage,
    public subscription: string | null,
    public rowId: string,
    public kind: "spend" | "usage",
    public usdCost?: number,
    public prefix: string = "dbx",
    public raw: Record<string, unknown> = {},
  ) {}

  get isByok(): boolean {
    return this.usdCost !== undefined;
  }

  /** Idempotency key for billing this row to the subscription its tags name. */
  get eventId(): string {
    return this.eventIdFor(this.subscription);
  }

  /**
   * The Databricks-side grouping key for this row, to be emitted as dimensions.
   *
   * This is what makes the connector checkable: the customer opens the Databricks page,
   * groups Lago the same way, and reads the two side by side. Without it the comparison
   * fails on naming alone — our `model` is normalized (`qwen35-122b-a10b`) where the
   * gateway page shows `system.ai.qwen35-122b-a10b` or even a display label
   * (`GPT OSS 20B`).
   *
   * Each kind gets the key that its OWN Databricks surface aggregates by, and only keys
   * that are true of the whole row:
   *
   *   * hosted — `endpoint_name`, how the AI Gateway usage page groups.
   *   * BYOK   — `bucket`, the hour, which is `external_model_spend`'s own aggregation
   *     key. Deliberately NOT `endpoint_name` here: a spend row covers an hour of
   *     requests, so any per-request field would be one sampled value dressed up as a
   *     property of the bucket.
   *
   * `invocation_id` / `request_id` / `status_code` are excluded for the same reason plus
   * cardinality — one Lago group per request is not a comparison, it's a list.
   */
  get reconcileDimensions(): Record<string, string> {
    if (this.kind === "spend") {
      const bucket = stamp(this.raw.bucket);
      return bucket ? { bucket } : {};
    }
    const endpoint = safeStr(this.usage.extras.endpoint_name);
    return endpoint ? { endpoint_name: endpoint } : {};
  }

  /**
   * The same key, scoped to whichever subscription is actually billed.
   *
   * Scoping is not cosmetic: Lago's `transaction_id` is unique account-wide, so an id
   * built from the source row alone silently blocks that row from ever reaching a second
   * subscription. And the subscription billed is not always the one on the row — an
   * untagged row falls back to the caller's default — so the key has to be built from the
   * resolved value, not from `this.subscription`.
   */
  eventIdFor(subscription: string | null | undefined): string {
    return `${this.prefix}_${this.kind}_${subscription || "none"}_${this.rowId}`;
  }
}

/** Render a window as a SQL predicate value. Rejects anything unrecognized. */
export function intervalSql(since: string | Date): string {
  if (since instanceof Date) {
    return `TIMESTAMP '${since.toISOString().slice(0, 19).replace("T", " ")}'`;
  }
  const m = INTERVAL_RE.exec(String(since));
  if (!m) {
    throw new Error(
      `since=${JSON.stringify(since)} not understood — pass a Date, or a string like ` +
        `'7 days' / '24 hours' / '30 minutes'`,
    );
  }
  return `current_timestamp() - INTERVAL ${m[1]} ${m[2].toUpperCase()}`;
}

export interface DatabricksSourceOptions {
  timeoutMs?: number;
  waitTimeout?: string;
}

/** Environment-shaped credentials supplied explicitly by the application boundary. */
export interface DatabricksSourceEnv {
  DATABRICKS_HOST?: string;
  DATABRICKS_TOKEN?: string;
  DATABRICKS_WAREHOUSE_ID?: string;
}

/**
 * Reads Databricks AI Gateway usage over the SQL Statement Execution API.
 *
 * Needs a PAT carrying the **`sql`** scope plus a SQL warehouse — the live `wrap()`
 * path needs neither. Without them every warehouse route returns
 * `403 "does not have required scopes: sql"`.
 *
 * A SQL warehouse is a real cost centre: measured on a test workspace, warehouse
 * queries cost roughly 1,500x the model-serving usage they were reporting on. Read one
 * wide window per run; never poll in a tight loop.
 */
export class DatabricksSource {
  readonly host: string;
  readonly timeoutMs: number;
  readonly waitTimeout: string;

  constructor(
    host: string,
    readonly token: string,
    readonly warehouseId: string,
    opts: DatabricksSourceOptions = {},
  ) {
    this.host = host.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    // Databricks rejects anything outside 0s or 5-50s.
    this.waitTimeout = opts.waitTimeout ?? "50s";
  }

  /** Build from explicitly supplied `DATABRICKS_*` values without reading global process state. */
  static fromEnv(env: DatabricksSourceEnv, opts: DatabricksSourceOptions = {}): DatabricksSource {
    const names: Array<keyof DatabricksSourceEnv> = [
      "DATABRICKS_HOST",
      "DATABRICKS_TOKEN",
      "DATABRICKS_WAREHOUSE_ID",
    ];
    const missing = names.filter((name) => !env[name]);
    if (missing.length) throw new Error(`missing environment variable(s): ${missing.join(", ")}`);
    return new DatabricksSource(
      env.DATABRICKS_HOST as string,
      env.DATABRICKS_TOKEN as string,
      env.DATABRICKS_WAREHOUSE_ID as string,
      opts,
    );
  }

  // ------------------------------------------------------------------
  // SQL
  // ------------------------------------------------------------------
  /**
   * Run one statement and return every row as an object.
   *
   * Handles the two things a naive reader gets wrong: the response is COLUMNAR
   * (`manifest.schema.columns` plus a positional `data_array`), and only chunk 0
   * arrives inline — the rest must be fetched, or a wide window truncates silently.
   */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    const headers = { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
    const resp = await fetch(`${this.host}${STATEMENTS_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        statement: sql,
        warehouse_id: this.warehouseId,
        wait_timeout: this.waitTimeout,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await this.awaitStatement((await resp.json()) as any, headers);

    const columns: string[] = (body?.manifest?.schema?.columns ?? []).map((c: any) => String(c.name));
    const arrays: unknown[][] = [...(body?.result?.data_array ?? [])];

    const totalChunks = Number(body?.manifest?.total_chunk_count ?? 1) || 1;
    const statementId = body?.statement_id;
    for (let index = 1; index < totalChunks; index++) {
      const chunkResp = await fetch(`${this.host}${STATEMENTS_PATH}/${statementId}/result/chunks/${index}`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const chunk = (await chunkResp.json()) as any;
      arrays.push(...(chunk?.data_array ?? []));
    }

    return arrays.map((row) => {
      const out: Record<string, unknown> = {};
      columns.forEach((name, i) => {
        out[name] = row[i];
      });
      return out;
    });
  }

  /**
   * Poll a statement to a terminal state, returning the body that carries results.
   *
   * A statement still executing when the request's `wait_timeout` elapses returns
   * **HTTP 200** with `state: PENDING`/`RUNNING` and a `statement_id` — not an error.
   * Treating that as fatal breaks exactly the case this class tells operators to use: one
   * wide window per run, which on a cold warehouse routinely takes longer than the 50s
   * ceiling Databricks allows for `wait_timeout`.
   */
  private async awaitStatement(body: any, headers: Record<string, string>): Promise<any> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const state = body?.status?.state;
      if (state === "SUCCEEDED") return body;
      if (state !== "PENDING" && state !== "RUNNING") {
        throw new Error(`Databricks statement ${state}: ${JSON.stringify(body?.status ?? body)}`);
      }
      const statementId = body?.statement_id;
      if (!statementId || Date.now() >= deadline) {
        throw new Error(
          `Databricks statement still ${state} after ${this.timeoutMs}ms ` +
            `(statement_id=${statementId}); raise \`timeoutMs\` or narrow the window`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const next = await fetch(`${this.host}${STATEMENTS_PATH}/${statementId}`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = (await next.json()) as any;
    }
  }

  // ------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------
  /**
   * Every billable row in the window, shaped for `emit()`.
   *
   * BYOK and hosted are read from DIFFERENT tables and must not overlap, or a call
   * gets billed twice:
   *
   *   * BYOK  — `external_model_spend`, which carries Databricks' own metered USD
   *     *and* your `request_tags`, so cost arrives already attributed per
   *     subscription. Token counts are joined on from `ai_gateway.usage` for
   *     reporting; they are not used to compute the price.
   *   * hosted — `ai_gateway.usage` only, billed as token counts.
   *
   * Rows whose usage is entirely zero (failed calls are recorded with NULL token
   * counts) are skipped, so nothing emits an empty event.
   */
  async readUsage(
    since: string | Date = "1 day",
    opts: { eventIdPrefix?: string } = {},
  ): Promise<DatabricksUsageRow[]> {
    const prefix = opts.eventIdPrefix ?? "dbx";
    const window = intervalSql(since);

    const spend = await this.query(`
            SELECT record_id,
                   date_trunc('HOUR', usage_start_time) AS bucket,
                   usage_metadata.provider              AS provider,
                   usage_metadata.model                 AS model,
                   to_json(custom_tags.request_tags)    AS request_tags,
                   usage_quantity
            FROM system.ai_gateway.external_model_spend
            WHERE usage_start_time >= ${window}
        `);

    const usage = await this.query(`
            SELECT * FROM system.ai_gateway.usage
            WHERE event_time >= ${window}
            ORDER BY event_time
        `);

    // Extract once per row and reuse: this loop and the hosted loop below both need the
    // CanonicalUsage, and extraction parses several JSON-string columns.
    const extracted = usage.map((row) => [row, extractDatabricksLog(row)] as const);

    // Index token counts by the spend table's own grouping key, so a BYOK event can
    // carry real counts alongside Databricks' dollar figure.
    const tokens = new Map<string, CanonicalUsage>();
    for (const [row, u] of extracted) {
      if (u.provider === "databricks") continue;
      const key = JSON.stringify([
        bucketOf(row.event_time),
        u.provider,
        safeStr(row.destination_model),
        canonicalTags(row.request_tags),
      ]);
      const prior = tokens.get(key);
      tokens.set(key, prior ? mergeUsage(prior, u) : asBucket(u));
    }

    const out: DatabricksUsageRow[] = [];
    const billedKeys = new Set<string>();

    for (const row of spend) {
      // NaN from an unparseable decimal(38,18) falls through the `!usd` guard and skips
      // the row, which is what Python's `_safe_float` does rather than raising.
      const usd = Number(row.usage_quantity ?? 0);
      if (!usd || !Number.isFinite(usd)) continue;
      const key = JSON.stringify([
        truncateHour(stamp(row.bucket)),
        safeStr(row.provider),
        safeStr(row.model),
        canonicalTags(row.request_tags),
      ]);
      billedKeys.add(key);
      const usageObj =
        tokens.get(key) ??
        makeCanonicalUsage({
          model: safeStr(row.model),
          provider: safeStr(row.provider),
          api: "databricks_gateway",
        });
      out.push(
        new DatabricksUsageRow(
          usageObj,
          resolveDatabricksSubscription({ request_tags: row.request_tags }),
          // record_id is unique per aggregated spend row — a natural idempotency key.
          // See `eventIdFor` for why it is still scoped.
          rowId(row, "record_id"),
          "spend",
          usd,
          prefix,
          row,
        ),
      );
    }

    // A BYOK bucket with no spend row is billed by NEITHER loop, so say so rather than
    // lose it. `external_model_spend` is an hourly aggregate that lags
    // `ai_gateway.usage`, so the window's most recent hour routinely has token rows whose
    // dollar row does not exist yet; a $0 metered row does the same. Re-running the window
    // once Databricks has aggregated picks them up — but only if the operator knows to,
    // which is what this warning is for.
    const unbilled = [...tokens.keys()].filter((k) => !billedKeys.has(k)).sort();
    if (unbilled.length) {
      const [hour, provider, model] = JSON.parse(unbilled[0]) as string[];
      console.warn(
        `[lago] ${unbilled.length} BYOK token bucket(s) in this window have no ` +
          `external_model_spend row yet and were NOT billed (e.g. hour=${hour} ` +
          `provider=${provider} model=${model}). The spend table lags; re-run this window ` +
          `later to bill them.`,
      );
    }

    for (const [row, u] of extracted) {
      if (u.provider !== "databricks") continue; // BYOK already billed from spend above
      if (Object.keys(nonzeroNumeric(u)).length === 0) continue; // failed calls: NULL tokens
      out.push(
        new DatabricksUsageRow(
          u,
          resolveDatabricksSubscription(row),
          // One request with a fallback yields several invocations, so invocation_id is
          // the per-row key; request_id is the fallback for a row that somehow carries
          // no invocation.
          rowId(row, "invocation_id", "request_id"),
          "usage",
          undefined,
          prefix,
          row,
        ),
      );
    }

    return out;
  }
}

/** Normalize a timestamp string to its hour, for joining across the two tables. */
function truncateHour(value: string): string {
  return value.length >= 13 ? value.slice(0, 13) : value;
}

/**
 * Stringify a timestamp column, whatever the access path produced.
 *
 * The Statement Execution API returns TIMESTAMPs as strings, but `@databricks/sql` returns
 * real `Date` objects — a documented, supported input path. `safeStr` maps those to "",
 * which collapses every hour of the window into one join bucket (so each hourly spend
 * event reports the WHOLE window's tokens) and drops the `bucket` reconcile dimension.
 */
function stamp(value: unknown): string {
  if (value === null || value === undefined) return "";
  // A Date MUST go through toISOString(). `String(date)` renders locale text like
  // "Fri Aug 07 2026 16:00:00 GMT+0200", whose first 13 characters are "Fri Aug 07 20" —
  // so `truncateHour` would key EVERY hour of the same day into one bucket, and the
  // emitted `bucket` dimension would change with the machine's locale and timezone.
  // ISO-8601 in UTC truncates to the correct hour and is stable everywhere.
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function bucketOf(value: unknown): string {
  return truncateHour(stamp(value));
}

/** A shallow copy with keys in sorted order, so JSON.stringify is deterministic. */
function sortedObject(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k];
  return out;
}

/**
 * First usable id among `columns`, falling back to a hash of the whole row.
 *
 * Two ways the obvious `safeStr(a || b)` goes wrong, both silent and both losing money. A
 * row with NULL ids yields ""; so does a row whose id a driver hands back as a non-string,
 * because `||` selects it and `safeStr` rejects the type without ever trying the next
 * column. Either way `eventIdFor` still produces a well-formed key (`dbx_usage_sub_x_`),
 * so EVERY such row in the window shares one `transaction_id` — Lago accepts the first and
 * rejects the rest as duplicates, and those calls are never billed at all.
 *
 * The content hash keeps the key deterministic, so re-running the same window is still
 * idempotent, which a random UUID would break.
 */
function rowId(row: Record<string, unknown>, ...columns: string[]): string {
  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  const canonical = JSON.stringify(sortedObject(row), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return `sha${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** Stable string form of a request_tags map, for use as a join key. */
function canonicalTags(value: unknown): string {
  let obj: unknown = value;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj || "{}");
    } catch {
      return String(value);
    }
  }
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    // Sorted OBJECT, not an array of pairs: an empty map must render "{}" so it keys
    // identically to a NULL `request_tags` column. Rendering it "[]" made an untagged
    // spend row miss its untagged usage rows — and untagged is the common case — so every
    // untagged BYOK event was emitted with all-zero token counts.
    return JSON.stringify(sortedObject(obj as Record<string, unknown>));
  }
  return "{}";
}

// Extras that describe the endpoint a spend bucket's requests went to, rather than any
// one of those requests. Everything else the adapter captures — `invocation_id`,
// `request_id`, `status_code` — is per-request, and carrying it on an hourly aggregate
// states one sampled request's value as if it described the whole hour.
const BUCKET_INVARIANT_EXTRAS = [
  "endpoint_name",
  "endpoint_id",
  "destination_type",
  "destination_name",
  "api_type",
];

/**
 * One usage row restated as a spend-bucket representative.
 *
 * Applied to the FIRST row of a bucket as well as to merges, so a bucket holding one
 * request is described the same way as a bucket holding ten — otherwise `status_code`
 * would survive on single-request hours and vanish on busy ones.
 */
function asBucket(u: CanonicalUsage): CanonicalUsage {
  const extras: Record<string, unknown> = {};
  for (const k of BUCKET_INVARIANT_EXTRAS) {
    if (k in u.extras) extras[k] = u.extras[k];
  }
  const out = makeCanonicalUsage({ model: u.model, provider: u.provider, api: u.api, extras });
  for (const name of NUMERIC_FIELDS) {
    (out as any)[name] = (u as any)[name];
  }
  return out;
}

/** Sum the numeric fields of two rows in the same spend bucket. */
function mergeUsage(a: CanonicalUsage, b: CanonicalUsage): CanonicalUsage {
  const merged = asBucket(a);
  for (const name of NUMERIC_FIELDS) {
    (merged as any)[name] = (a as any)[name] + (b as any)[name];
  }
  return merged;
}
