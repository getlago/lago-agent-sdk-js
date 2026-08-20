/** Shared helpers used by more than one native provider adapter. */

/**
 * Prefer the model a response reports over the one requested.
 *
 * Every native provider resolves a short alias to a specific snapshot server-side
 * ("claude-sonnet-4-5" -> "claude-sonnet-4-5-20250929"; Gemini hot-swaps "-latest").
 * Pricing and attribution must key off what actually answered, because OpenRouter lists
 * the resolved snapshot and not the alias. Falls back to the requested model only when
 * the response is silent about its own (e.g. a synthetic streaming usage blob).
 */
export function resolveModel(responseModel: unknown, requestedModel: string): string {
  if (typeof responseModel === "string" && responseModel) return responseModel;
  return requestedModel || "";
}
