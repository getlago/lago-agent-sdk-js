/** Property-based fuzzing — adapters never crash and never produce negatives. */
import fc from "fast-check";
import { describe, it } from "vitest";

import {
  extractBedrockConverse,
  extractBedrockInvoke,
  extractMistralNative,
  pickInvokeAdapter,
} from "../../src/adapters/index.js";
import { NUMERIC_FIELDS } from "../../src/canonical.js";

const garbage = fc.letrec((tie) => ({
  leaf: fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.float({ noNaN: true }),
    fc.string({ maxLength: 10 }),
  ),
  array: fc.array(tie("any") as fc.Arbitrary<unknown>, { maxLength: 5 }),
  obj: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie("any") as fc.Arbitrary<unknown>, {
    maxKeys: 5,
  }),
  any: fc.oneof(
    { maxDepth: 3 },
    tie("leaf"),
    tie("array") as fc.Arbitrary<unknown>,
    tie("obj") as fc.Arbitrary<unknown>,
  ),
})).any;

const someModelId = fc.constantFrom(
  "eu.anthropic.claude-sonnet-4-6",
  "eu.anthropic.claude-opus-4-7",
  "eu.amazon.nova-lite-v1:0",
  "openai.gpt-oss-20b-1:0",
  "openai.gpt-oss-safeguard-20b-1:0",
  "eu.mistral.pixtral-large-2502-v1:0",
  "mistral.mistral-large-2402-v1:0",
  "mistral.mistral-7b-instruct-v0:2",
  "eu.minimax.minimax-m2-v1:0",
  "eu.qwen.qwen3-235b-a22b-instruct-2507-v1:0",
  "",
);

function assertCanonicalInvariants(u: ReturnType<typeof extractBedrockConverse>) {
  for (const f of NUMERIC_FIELDS) {
    const v = u[f];
    if (typeof v !== "number" || v < 0 || !Number.isInteger(v)) {
      throw new Error(`Invariant violated: ${f}=${v}`);
    }
  }
  if (typeof u.extras !== "object" || u.extras === null) throw new Error("extras missing");
}

describe("Property-based fuzz", () => {
  it("Converse adapter survives random input", () => {
    fc.assert(
      fc.property(garbage, someModelId, (g, mid) => {
        const input = (g as any) && typeof g === "object" && !Array.isArray(g) ? g : { usage: g };
        const u = extractBedrockConverse(input, mid);
        assertCanonicalInvariants(u);
      }),
      { numRuns: 300 },
    );
  });

  it("Invoke adapter survives random input", () => {
    fc.assert(
      fc.property(garbage, someModelId, (g, mid) => {
        const input = (g as any) && typeof g === "object" && !Array.isArray(g) ? g : { usage: g };
        const u = extractBedrockInvoke(input, mid);
        assertCanonicalInvariants(u);
      }),
      { numRuns: 300 },
    );
  });

  it("Mistral adapter survives random input", () => {
    fc.assert(
      fc.property(garbage, someModelId, (g, mid) => {
        const input = (g as any) && typeof g === "object" && !Array.isArray(g) ? g : { usage: g };
        const u = extractMistralNative(input, mid);
        assertCanonicalInvariants(u);
      }),
      { numRuns: 300 },
    );
  });

  it("pickInvokeAdapter returns a known family for any string", () => {
    const known = new Set([
      "openai_compat_basic",
      "openai_compat_with_details",
      "anthropic",
      "opus_4_7",
      "nova",
      "pixtral",
      "mistral_legacy",
    ]);
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (mid) => {
        if (!known.has(pickInvokeAdapter(mid))) {
          throw new Error(`unknown family for ${mid}`);
        }
      }),
      { numRuns: 300 },
    );
  });
});
