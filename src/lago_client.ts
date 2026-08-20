/** Thin HTTP client to Lago. */
// TYPE-only, so it is erased at compile time and `undici` is never a load-time
// requirement. The runtime import is dynamic, inside `dispatcher()`.
import type { Agent } from "undici";

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
   * TLS verification for requests to `apiUrl`. Defaults to true; the one legitimate
   * reason to disable is a local dev Lago behind a self-signed cert.
   *
   * Scoped via undici's `Agent`, passed as `dispatcher` on the affected requests only —
   * NOT `NODE_TLS_REJECT_UNAUTHORIZED`, which would weaken TLS process-wide rather than
   * just for calls to `apiUrl`.
   */
  readonly verifySsl: boolean;
  /** Cached as the PROMISE, not the Agent: concurrent sends then share one dynamic
   * import and one Agent instead of racing to build several. */
  private insecureAgent: Promise<Agent | undefined> | undefined;

  constructor(
    private apiKey: string,
    private apiUrl: string,
    private timeoutMs: number = 10_000,
    verifySsl: boolean = true,
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.verifySsl = verifySsl;
  }

  /** The dispatcher that skips TLS verification for `apiUrl`, built on first use.
   *
   * `undici` is imported HERE rather than at module load because this dev-only path is
   * the only thing in the SDK that needs it. A static import made the package
   * unloadable anywhere `undici` cannot be resolved — a non-Node runtime (Workers,
   * edge, a browser bundle) where global `fetch` alone would have been enough — which
   * is a poor trade for a package whose headline feature is a Cloudflare integration.
   */
  private dispatcher(): Promise<Agent | undefined> {
    this.insecureAgent ??= import("undici")
      .then(({ Agent }) => new Agent({ connect: { rejectUnauthorized: false } }))
      .catch((err) => {
        // Deliberately NOT a silent downgrade to a verifying request: the send goes
        // ahead (and most likely fails on the self-signed cert, which the queue treats
        // as transient and retries), but the reason is stated once, with the fix.
        console.warn(
          "[lago] verifySsl:false needs the optional `undici` package; install it or " +
            "set verifySsl:true. Sending with TLS verification ON:",
          err,
        );
        return undefined;
      });
    return this.insecureAgent;
  }

  async sendBatch(events: LagoEvent[]): Promise<void> {
    if (events.length === 0) return;
    const url = `${this.apiUrl}/events/batch`;
    // Resolved before the timeout timer starts: a one-off module import must not eat
    // into the request's own budget.
    const dispatcher = this.verifySsl ? undefined : await this.dispatcher();
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
        ...(dispatcher ? { dispatcher } : {}),
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
