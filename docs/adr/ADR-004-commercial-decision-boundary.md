# ADR-004: Commercial decision boundary

Status: Accepted. 2026-08-02.

## Context

The gateway is the first surface of a **Commercial Runtime**. Today it makes exactly one pre-execution decision — WP4's budget allow/deny with 402 semantics — and everything else is implied by the request: the customer names the provider and model, the gateway executes, and pricing happens after the fact. That inverts the commercial relationship. The customer's contract expresses business intent (latency priority, quality floor, budget, allowed providers, minimum margin); which provider and model serve a request should be an *output* of that intent, not an input the customer hardcodes. A static `premium plan = Anthropic` mapping is explicitly not the design — it is a pricing table wearing a policy costume, and it breaks the moment provider economics move.

The lifecycle this ADR defines:

`intent → decision → reservation → execution → settlement`

This is not an expansion into generic AI routing or governance. The decision is commercial — is this customer entitled, can they pay, which execution satisfies their priced priorities within the margin floor — and its v1 policy vocabulary is deliberately narrow. Content-aware routing, fallback optimization, and a general policy DSL stay out (see ADR-001's exclusions, which stand).

## Decision

**Every request passes a pre-execution `CommercialDecisionEngine` that emits an auditable, versioned decision; funds are atomically reserved before any provider call; execution is delegated through a pluggable `ExecutionAdapter`; settlement reconciles the reservation against actual usage. Lago owns the decision and the financial record; the selected provider or optional proxy merely executes.**

1. **Inputs.** A `Capability` — what the customer is asking for in provider-neutral terms: capability kind (chat completion first), quality tier, expected token envelope, latency priority, tool use — derived from the request and the key's configuration. Plus the **customer commercial context**: Lago customer and subscription, plan entitlements, remaining budget and credits, customer-specific selling prices, allowed providers, and the minimum-margin floor. The engine sees no prompt content; redaction guarantees (WP5) are unchanged.
2. **Decision.** Before any provider is dialed, the engine persists a decision record: `decision_id`, `policy_version`, allow/deny/downgrade, machine-readable reason codes, the **execution instruction** (provider profile, model, region — chosen from the certified profiles of ADR-001 using their versioned cost catalogs and measured performance data) or the denial, and the **economic reservation** (expected provider cost, customer price, expected margin). The record is append-only: a decision is never edited, only settled or superseded, so every invoice line traces to the decision that authorized it and the policy version that produced it.
3. **Atomic reservation.** The reservation debits budget/credit headroom in the same SQLite transaction that persists the decision (same store and single-writer discipline as ADR-003), before provider execution. Two concurrent requests cannot both spend the last of a budget. Streams reserve on the request's token envelope (`max_tokens` or the profile default cap); settlement trues it up.
4. **Execution.** The decision's instruction executes through one `ExecutionAdapter` boundary. The certified implementation is ADR-001's direct-dial transport parameterized by the instructed provider profile; Bifrost/LiteLLM remain optional adapters behind the same boundary. An adapter receives an instruction and returns raw provider bytes; it holds no commercial state and makes no commercial choices.
5. **Settlement.** Actual usage (extracted per ADR-001) prices actual provider cost and customer charge; settlement replaces the reservation with realized numbers — releasing residual headroom or recording the overage — and completes the financial record (WP10) with expected *and* realized margin. Provider failure before any billable usage releases the reservation in full; partial streamed usage settles for what was delivered (abort-still-bills, WP5, is unchanged).
6. **Idempotency and retries.** `decision_id` keys the lifecycle. A retried request presenting the same idempotency key reuses its undecided-or-reserved decision rather than reserving twice; settlement is at-least-once with the same replay discipline as the outbox (ADR-003), and the emitted Lago events carry the existing `transaction_id` dedupe plus `decision_id` lineage. A crash between reservation and settlement replays to settlement or release on restart — a reservation can never leak.
7. **v1 policies (deliberately narrow).** Entitlement (is the capability in the plan), budget/credit availability, latency-or-quality priority, and minimum-margin protection. Provider choice is the engine solving those constraints against the certified profiles' cost catalogs and measured latency — e.g. a premium customer's latency-priority policy selects an Anthropic route despite its higher expected cost because the expected customer price still clears the margin floor; a standard customer gets the cheapest route satisfying its quality floor; a request is downgraded when the preferred route would violate the margin floor; a request is denied before execution when budget or credits are exhausted (the WP4 402 shape, now with `decision_id` and reason codes).

## Consequences

- WP4's budget check is subsumed: it becomes one policy in the engine rather than a bespoke gate, and its fail-open default + per-key strict semantics carry over as engine configuration.
- The reservation ledger makes budget enforcement exact instead of TTL-cache-approximate for the balances the gateway owns; the Lago-backed check remains the source of truth the ledger syncs against.
- Every response can expose `decision_id`, the decision reason, and expected vs. realized margin — which is precisely the surface the launch demo scenarios need (PR #26).
- One more write on the request hot path (decision + reservation commit). It shares the transaction with work the gateway already does before execution, on the same single-writer SQLite; the crash-test bill (ADR-003) extends to the reservation lifecycle.
- Providers become substitutable per request, so the compatibility matrix (WP11) also gates which profiles the engine may instruct: an uncertified profile is not a legal decision output.

## Out of launch scope

A general policy DSL. Generic AI routing and model selection beyond the v1 policy vocabulary above. Fallback optimization. Broad governance. Prompt observability. These remain excluded exactly as in ADR-001; this ADR adds a commercial decision in front of execution, not a routing product.

## NEEDS-HUMAN-CONFIRMATION

1. Reservation sizing for streams with no client-supplied `max_tokens`: confirm the per-profile default cap is acceptable 402/denial behavior for design partners, or whether such requests should reserve at the plan's per-request ceiling.
2. The latency data behind latency-priority decisions: confirm it comes from the per-profile contract-test measurements (WP11) at launch, with no runtime probing.
