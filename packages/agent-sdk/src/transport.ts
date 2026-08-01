/** EventTransport — the delivery contract behind the SDK queue and the
 * gateway's durable outbox.
 *
 * Two implementations with deliberately opposite overflow behavior:
 * - `EventQueue` (SDK default): in-memory, fail-open, drops oldest on
 *   overflow. Instrumentation must never block or crash the host app.
 * - `DurableEventQueue` (gateway mode): write-ahead persisted, fail-closed.
 *   `push` returns "rejected" when the outbox is full so the caller can
 *   refuse the LLM request before any provider call.
 */
import type { LagoEvent } from "./lago_client.js";

export type PushResult = "accepted" | "rejected";

export interface EventTransport {
  /** Offer an event. Must never throw. */
  push(event: LagoEvent): PushResult;
  /** Resolve true once everything accepted so far has been delivered. */
  flush(timeoutMs?: number): Promise<boolean>;
  /** Flush best-effort, then stop the delivery loop. */
  shutdown(timeoutMs?: number): Promise<void>;
  /** Events accepted but not yet delivered (buffered + in flight). */
  depth(): number;
  /** Age in ms of the oldest undelivered event, 0 when empty. */
  lagMs(): number;
}
