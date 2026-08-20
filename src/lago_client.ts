/** Thin HTTP client to Lago. */
// TYPE-only — a value import here loaded undici on every `import` of this SDK, for an
// object only ever constructed when `verifySsl === false`. That cost three things: every
// consumer paid the module load, `engines.node >= 18.17` became mandatory for a dev-only
// convenience, and the package could not load AT ALL in a non-Node runtime (Workers,
// edge, browser bundles) where global `fetch` would have been sufficient. That last one
// is the one that matters: this SDK's headline gateway connector is Cloudflare, so
// "runs in a Worker" is a plausible ask, and a static import foreclosed it for a flag
// most consumers never touch. The real Agent now arrives via `await import()` in
// `ensureAgent()`, so the dependency is only resolved by someone who asked for it.
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
    // Deliberately NOT created here: the constructor cannot await, and eagerly
    // importing undici is the whole problem. Created lazily on first send instead —
    // see `ensureAgent()`.
  }

  /** The TLS-bypass dispatcher, imported and constructed on first use.
   *
   * Only ever called when `verifySsl === false`, so a consumer who never sets that flag
   * never resolves `undici` at all — which is what lets this package load in a runtime
   * that has global `fetch` but not Node's socket internals. Memoized on the promise,
   * not the agent, so concurrent first sends share one import and one Agent rather than
   * racing to build several connection pools. */
  private agentPromise: Promise<Agent | undefined> | undefined;

  private ensureAgent(): Promise<Agent | undefined> {
    if (this.verifySsl) return Promise.resolve(undefined);
    if (!this.agentPromise) {
      this.agentPromise = import("undici")
        .then(({ Agent }) => {
          const agent = new Agent({ connect: { rejectUnauthorized: false } });
          this.insecureAgent = agent;
          return agent;
        })
        .catch((err) => {
          // undici is an optional dependency now. Missing it is only reachable for a
          // caller who asked for verifySsl:false in an environment without it, and the
          // honest outcome is a clear error rather than silently verifying TLS after
          // being told not to — that would turn a dev convenience into a confusing
          // connection failure against a self-signed cert.
          this.agentPromise = undefined;
          throw new Error(
            `verifySsl:false needs the optional "undici" dependency, which could not be loaded: ${String(err)}`,
          );
        });
    }
    return this.agentPromise;
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
    // Clear the memo too, so a close()-then-send() sequence builds a fresh pool
    // instead of handing back an Agent whose sockets have already been released.
    this.agentPromise = undefined;
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
    const dispatcher = await this.ensureAgent();
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
