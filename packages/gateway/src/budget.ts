/** Budget enforcement (WP4).
 *
 * Synchronous pre-request check against the virtual key's budget policy,
 * backed by Lago's current-usage API with a short-TTL cache: at most one
 * Lago call per subscription per TTL window, so the cached path adds
 * microseconds, not a network hop.
 *
 * Failure semantics (documented in the gateway README):
 * - confirmed-exhausted budget → reject; the server returns HTTP 402 with a
 *   machine-readable body
 * - Lago unreachable → fail-open + loud alert metric by default; a key with
 *   `budget.strict` flips to fail-closed
 */
import type { VirtualKeyRecord } from "./store.js";

export type BudgetDecision =
  | { allow: true; reason: "no_budget" | "under_budget" | "fail_open" }
  | { allow: false; reason: "exhausted" | "fail_closed"; spent_usd?: number; limit_usd?: number };

export interface BudgetChecker {
  check(vk: VirtualKeyRecord): Promise<BudgetDecision>;
}

/** Default checker when no Lago budget source is wired: everything passes. */
export class AllowAllBudgetChecker implements BudgetChecker {
  async check(): Promise<BudgetDecision> {
    return { allow: true, reason: "no_budget" };
  }
}

export interface LagoBudgetCheckerOptions {
  lagoApiUrl: string;
  lagoApiKey: string;
  ttlMs?: number;
  timeoutMs?: number;
  onError?: (err: unknown, where: string) => void;
  /** Fired on every Lago-unreachable check (the loud alert). */
  onCheckFailure?: () => void;
}

interface CacheEntry {
  spentUsd: number;
  at: number;
}

export class LagoBudgetChecker implements BudgetChecker {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(private opts: LagoBudgetCheckerOptions) {
    this.ttlMs = opts.ttlMs ?? 5_000;
    this.timeoutMs = opts.timeoutMs ?? 1_500;
  }

  async check(vk: VirtualKeyRecord): Promise<BudgetDecision> {
    const budget = vk.budget;
    if (!budget || budget.limit_usd === undefined) {
      return { allow: true, reason: "no_budget" };
    }
    if (!vk.external_customer_id) {
      // No customer to query usage for. Enforcing an unqueryable budget
      // would 402 every call; treat as unbudgeted and surface it.
      this.opts.onError?.(
        new Error(`key ${vk.id} has a budget but no external_customer_id; cannot enforce`),
        "budget",
      );
      return { allow: true, reason: "no_budget" };
    }

    const cacheKey = `${vk.external_customer_id}\n${vk.external_subscription_id}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      return this.decide(cached.spentUsd, budget.limit_usd);
    }

    let spentUsd: number;
    try {
      spentUsd = await this.fetchSpentUsd(vk.external_customer_id, vk.external_subscription_id);
    } catch (err) {
      this.opts.onError?.(err, "budget");
      this.opts.onCheckFailure?.();
      if (budget.strict) {
        return { allow: false, reason: "fail_closed", limit_usd: budget.limit_usd };
      }
      return { allow: true, reason: "fail_open" };
    }
    this.cache.set(cacheKey, { spentUsd, at: Date.now() });
    return this.decide(spentUsd, budget.limit_usd);
  }

  private decide(spentUsd: number, limitUsd: number): BudgetDecision {
    if (spentUsd >= limitUsd) {
      return { allow: false, reason: "exhausted", spent_usd: spentUsd, limit_usd: limitUsd };
    }
    return { allow: true, reason: "under_budget" };
  }

  /** Lago current usage for the subscription's active period. */
  private async fetchSpentUsd(customerId: string, subscriptionId: string): Promise<number> {
    const url =
      `${this.opts.lagoApiUrl}/customers/${encodeURIComponent(customerId)}/current_usage` +
      `?external_subscription_id=${encodeURIComponent(subscriptionId)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.opts.lagoApiKey}` },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`current_usage -> ${resp.status}`);
      const body = (await resp.json()) as { customer_usage?: { total_amount_cents?: number } };
      const cents = body.customer_usage?.total_amount_cents;
      if (typeof cents !== "number") throw new Error("current_usage: missing total_amount_cents");
      return cents / 100;
    } finally {
      clearTimeout(timer);
    }
  }
}
