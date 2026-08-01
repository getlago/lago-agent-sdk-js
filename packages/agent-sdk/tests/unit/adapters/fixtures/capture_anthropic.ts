/**
 * Capture a few real Anthropic JS-SDK responses to verify the npm SDK's response shape
 * (snake_case wire JSON vs. camelCase rebrand). Reads ANTHROPIC_API_KEY from env.
 *
 * Run with: ANTHROPIC_API_KEY="..." tsx tests/unit/adapters/fixtures/capture_anthropic.ts
 */
import { Anthropic } from "@anthropic-ai/sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "anthropic_native");
mkdirSync(OUT, { recursive: true });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

async function main() {
  const PROMPT = "Write one sentence about dolphins.";

  // 1. Plain — haiku
  console.log("[1] plain — claude-haiku-4-5-20251001");
  const r1 = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 80,
    messages: [{ role: "user", content: PROMPT }],
  });
  writeFileSync(
    join(OUT, "01_plain_haiku.json"),
    JSON.stringify({ _model_id: "claude-haiku-4-5-20251001", _response: r1 }, null, 2),
  );

  // 2. Tool use
  console.log("[2] tool use — claude-sonnet-4-6");
  const r2 = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather for a city.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
  });
  writeFileSync(
    join(OUT, "02_tool_use.json"),
    JSON.stringify({ _model_id: "claude-sonnet-4-6", _response: r2 }, null, 2),
  );

  // 3. Cache create with cache_control
  console.log("[3] cache create — long system + ephemeral 5m");
  const LONG_TEXT =
    "You are a helpful assistant. Answer concisely. ".repeat(200) +
    "Always cite step by step. ".repeat(100);
  const r3 = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 30,
    system: [{ type: "text", text: LONG_TEXT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "What's 2+2?" }],
  });
  writeFileSync(
    join(OUT, "03_cache_create.json"),
    JSON.stringify({ _model_id: "claude-sonnet-4-6", _response: r3 }, null, 2),
  );

  console.log("Done. Inspect tests/unit/adapters/fixtures/anthropic_native/*.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
