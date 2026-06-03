/** Detect which client kind was passed to wrap(). */

export type ClientKind =
  | "bedrock"
  | "anthropic"
  | "openai"
  | "mistral"
  | "gemini"
  | "gemini_legacy"
  | "unknown";

export function detectClientKind(client: unknown): ClientKind {
  if (!client || typeof client !== "object") return "unknown";

  const ctor = (client as { constructor?: { name?: string } }).constructor;
  const ctorName = (ctor?.name || "").toLowerCase();

  // AWS SDK v3 BedrockRuntimeClient — has .send and serviceId or config metadata
  if (
    ctorName.includes("bedrockruntime") ||
    (typeof (client as { send?: unknown }).send === "function" &&
      JSON.stringify((client as { config?: unknown }).config || {}).includes("bedrock-runtime"))
  ) {
    return "bedrock";
  }

  // mistralai SDK
  if (ctorName === "mistral" || ctorName.includes("mistral")) return "mistral";

  // OpenAI / Anthropic / Google heuristics for future Phase 2
  if (ctorName.includes("anthropic")) return "anthropic";
  if (ctorName === "openai" || ctorName.startsWith("openai")) return "openai";
  // New unified @google/genai SDK only (GoogleGenAI). The legacy
  // @google/generative-ai SDK (GoogleGenerativeAI) has a different surface the
  // gemini wrapper cannot instrument, so it would silently wrap nothing — flag
  // it separately so wrap() can reject it with a clear migration message.
  // "googlegenai" is not a substring of "googlegenerativeai", so no overlap.
  if (ctorName.includes("googlegenai")) return "gemini";
  if (ctorName.includes("googlegenerativeai")) return "gemini_legacy";

  return "unknown";
}
