/** Pure Lago event builders.
 *
 * Extracted from LagoSDK so gateway-mode consumers (`@getlago/agent-sdk/core`)
 * can build events without an SDK instance. `transaction_id` is assigned here,
 * at build time — never at send time — so a retry or an outbox replay re-sends
 * the same id and Lago's idempotency dedupes it.
 */
import { randomUUID } from "node:crypto";

import { CanonicalUsage, NUMERIC_FIELDS, nonzeroNumeric } from "./canonical.js";
import type { LagoEvent } from "./lago_client.js";
import { CostBreakdown, ModelPrice, computeCost } from "./pricing.js";

export interface BuildEventOptions {
  dimensions?: Record<string, unknown>;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
}

/** One event per non-zero usage dimension that has a metric code. */
export function buildTokenEvents(
  usage: CanonicalUsage,
  subscriptionId: string,
  metricCodes: Record<string, string>,
  opts: BuildEventOptions = {},
): LagoEvent[] {
  const counts = nonzeroNumeric(usage);
  const now = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const events: LagoEvent[] = [];
  for (const field of NUMERIC_FIELDS) {
    const value = counts[field];
    if (!value) continue;
    const code = metricCodes[field];
    if (!code) continue;
    events.push({
      transaction_id: randomUUID(),
      external_subscription_id: subscriptionId,
      code,
      timestamp: now,
      properties: {
        value: String(value),
        model: usage.model,
        provider: usage.provider,
        api: usage.api,
        ...(opts.dimensions || {}),
      },
    });
  }
  return events;
}

/** Single dollar-cost event (price mode) with the full per-field breakdown. */
export function buildCostEvent(
  usage: CanonicalUsage,
  subscriptionId: string,
  price: ModelPrice,
  markupScaled: bigint,
  costMetricCode: string,
  opts: BuildEventOptions = {},
): { event: LagoEvent; breakdown: CostBreakdown } {
  const breakdown = computeCost(usage, price, markupScaled);
  // `unit` = total tokens for the call — the quantity the sum-aggregation
  // billable metric sums (the dynamic charge's fee comes from
  // precise_total_amount_cents; unit is the displayed usage quantity).
  // Sum the *billed* per-field counts from the breakdown, which computeCost has
  // already de-overlapped (e.g. cache_read carved out of input), so subset
  // fields aren't double-counted in the displayed total.
  const unit = Object.values(breakdown.fields).reduce((s, p) => s + Number(p.tokens), 0);
  const properties: Record<string, unknown> = {
    unit: String(unit),
    value: breakdown.total,
    base_cost: breakdown.base,
    markup: breakdown.markup,
    model: usage.model,
    provider: usage.provider,
    api: usage.api,
    price_source: breakdown.source,
  };
  for (const [field, parts] of Object.entries(breakdown.fields)) {
    properties[`${field}_tokens`] = parts.tokens;
    properties[`${field}_unit_price`] = parts.unit_price;
    properties[`${field}_cost`] = parts.cost;
  }
  Object.assign(properties, opts.dimensions || {});
  const event: LagoEvent = {
    transaction_id: randomUUID(),
    external_subscription_id: subscriptionId,
    code: costMetricCode,
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    // Top-level amount (in cents) for Lago's dynamic charge model — the charge
    // sums these into a single fee.
    precise_total_amount_cents: breakdown.totalCents,
    properties,
  };
  return { event, breakdown };
}
