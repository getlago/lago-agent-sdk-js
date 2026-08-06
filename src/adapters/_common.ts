/** Shared helpers used by more than one native provider adapter. */

/**
 * Prefer the model a response reports over the one requested.
 *
 * Every native provider can resolve a short alias/moniker to a more
 * specific snapshot id server-side, under different names — Anthropic and
 * OpenAI turn a short alias into a dated snapshot (e.g.
 * "claude-sonnet-4-5" -> "claude-sonnet-4-5-20250929"), Gemini hot-swaps
 * "-latest" aliases the same way (see
 * https://ai.google.dev/gemini-api/docs/models). Pricing/attribution must
 * key off what actually answered: OpenRouter lists the resolved snapshot,
 * never the alias. Falls back to the requested model only when the
 * response is silent about its own model (e.g. a synthetic streaming
 * usage blob).
 */
export function resolveModel(responseModel: unknown, requestedModel: string): string {
  if (typeof responseModel === "string" && responseModel) return responseModel;
  return requestedModel || "";
}
