/**
 * Ramp Router host detection, shared by every wrapper a customer can point at Router.
 *
 * Router serves every provider it fronts through one dedicated host on two surfaces —
 * `/v1/responses` (reached with an OpenAI client) and `/v1/messages` (reached with an
 * Anthropic client). Neither surface leaves a mark in the response body: an
 * Anthropic-served answer on the first is byte-indistinguishable from real OpenAI, and any
 * vendor's answer on the second is rendered in Anthropic's schema. So the client's base URL
 * is the ONLY signal, and both wrappers must read it the same way — a copy in each would
 * drift, and the Anthropic wrapper going without one billed Router traffic as native
 * Anthropic (wrong price table, no Router key learned).
 *
 * It must be the PARSED host, never a substring test. A substring row ("api.router.com")
 * also matches `https://evil.example.com/api.router.com/v1`, which would stamp an unrelated
 * endpoint's traffic as Router-served. The `.router.com` suffix arm covers a regional or
 * staging host without widening to arbitrary domains — `evilrouter.com` does not end in
 * `.router.com`.
 */

export const RAMP_ROUTER_HOST = "api.router.com";
export const RAMP_ROUTER_DOMAIN = ".router.com";

/**
 * True when `baseUrl` names Router's host. A relative, malformed or non-string value is not
 * a gateway — and never throws, because this runs inside `wrap()`.
 */
export function isRampRouterBaseUrl(baseUrl: unknown): boolean {
  let host: string;
  try {
    host = new URL(String(baseUrl ?? "")).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === RAMP_ROUTER_HOST || host.endsWith(RAMP_ROUTER_DOMAIN);
}

/**
 * Read the client's `baseURL` defensively and test it. Both the openai and
 * @anthropic-ai/sdk clients expose the constructor's URL as `.baseURL`; some client
 * variants may not, and a getter that throws must not break `wrap()`.
 */
export function clientPointsAtRampRouter(client: unknown): boolean {
  try {
    return isRampRouterBaseUrl((client as { baseURL?: unknown })?.baseURL);
  } catch {
    return false;
  }
}
