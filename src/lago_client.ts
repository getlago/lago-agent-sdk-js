/** Thin HTTP client to Lago. */
import { Agent } from "undici";

import { LagoApiError } from "./exceptions.js";

export interface LagoEvent {
  transaction_id: string;
  external_subscription_id: string;
  code: string;
  timestamp: number;
  /** Amount in cents for Lago's dynamic charge model (price mode only). */
  precise_total_amount_cents?: string;
  properties: Record<string, unknown>;
}

export class LagoClient {
  /**
   * TLS certificate verification for requests to `apiUrl`. Defaults to
   * `true` (always verify — never disable this against a real Lago
   * instance). The one legitimate reason to set `false`: a local dev Lago
   * instance behind a self-signed certificate (e.g. Traefik's default
   * local cert), where the alternative is routing through a public tunnel
   * (ngrok, etc.) purely to get a browser-trusted cert — adding a flaky,
   * unnecessary network hop for a problem this flag solves directly.
   *
   * Node's global `fetch()` has no per-request TLS-bypass option the way
   * Python's `requests` does (`verify=False`) — it's scoped here via
   * undici's `Agent`, passed as `dispatcher` on the affected requests only,
   * never as a process-wide setting (e.g. `NODE_TLS_REJECT_UNAUTHORIZED`),
   * which would weaken TLS for the entire process, not just calls to `apiUrl`.
   */
  readonly verifySsl: boolean;
  private insecureAgent: Agent | undefined;

  constructor(
    private apiKey: string,
    private apiUrl: string,
    private timeoutMs: number = 10_000,
    verifySsl: boolean = true,
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.verifySsl = verifySsl;
    this.insecureAgent = verifySsl ? undefined : new Agent({ connect: { rejectUnauthorized: false } });
  }

  /** Releases the undici Agent created for `verifySsl: false`.
   *
   * Resource hygiene, NOT a process-exit fix — measured, not assumed: with the Agent
   * left open a script still exited immediately, because undici's sockets are not
   * ref'd handles. (What actually held the loop open for the full shutdown timeout was
   * the uncancelled race timer in `EventQueue.shutdown`, now fixed there.) What this
   * does buy is a process that constructs many short-lived `LagoSDK` instances — a
   * per-request or per-tenant SDK — not accumulating one connection pool per instance
   * with nothing to release them. Idempotent and best-effort: shutdown must never
   * throw because a socket pool objected. */
  async close(): Promise<void> {
    const agent = this.insecureAgent;
    if (!agent) return;
    this.insecureAgent = undefined;
    try {
      await agent.close();
    } catch {
      /* releasing sockets must never fail shutdown */
    }
  }

  async sendBatch(events: LagoEvent[]): Promise<void> {
    if (events.length === 0) return;
    const url = `${this.apiUrl}/events/batch`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events }),
        signal: ctrl.signal,
        ...(this.insecureAgent ? { dispatcher: this.insecureAgent } : {}),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new LagoApiError(resp.status, body);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
