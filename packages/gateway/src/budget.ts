/** Budget enforcement interface. WP4 supplies the Lago-backed implementation;
 * the server wires whichever checker it is given. */
import type { BudgetPolicy } from "./store.js";

export type BudgetDecision =
  | { allow: true; reason: "no_budget" | "under_budget" | "fail_open" }
  | { allow: false; reason: "exhausted" | "fail_closed"; spent_usd?: number; limit_usd?: number };

export interface BudgetChecker {
  check(subscriptionId: string, budget: BudgetPolicy | null): Promise<BudgetDecision>;
}

/** Default checker until WP4: no budget data source, so everything passes. */
export class AllowAllBudgetChecker implements BudgetChecker {
  async check(): Promise<BudgetDecision> {
    return { allow: true, reason: "no_budget" };
  }
}
