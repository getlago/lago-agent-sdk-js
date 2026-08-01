/** Structured JSON logs, metadata only.
 *
 * The redaction contract for a billing gateway: NEVER log prompts,
 * completions, provider keys, or virtual keys. `log()` takes a flat metadata
 * object and refuses known-sensitive field names outright, so a future call
 * site can't accidentally widen the surface.
 */

const FORBIDDEN_FIELDS = new Set([
  "messages",
  "prompt",
  "completion",
  "content",
  "authorization",
  "api_key",
  "apikey",
  "key",
  "body",
]);

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(stream: NodeJS.WritableStream = process.stdout): Logger {
  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    const entry: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      msg,
    };
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        if (FORBIDDEN_FIELDS.has(k.toLowerCase())) continue;
        if (typeof v === "string" && looksLikeSecret(v)) continue;
        entry[k] = v;
      }
    }
    stream.write(JSON.stringify(entry) + "\n");
  };
  return {
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
  };
}

/** Defense in depth: drop values that look like key material even when the
 * field name is innocent. */
function looksLikeSecret(v: string): boolean {
  return /^(lago_vk_|sk-|sk_ant|Bearer\s)/i.test(v) || /^[A-Za-z0-9+/_-]{40,}$/.test(v);
}
