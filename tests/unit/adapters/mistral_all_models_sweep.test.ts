/** Sweep every captured Mistral model — every fixture must extract cleanly.
 *
 * Mirrors test_mistral_all_models_sweep.py. Run shared/fixtures/capture_mistral_all.py
 * to refresh fixtures.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractMistralNative } from "../../../src/adapters/index.js";

const ROOT = join(__dirname, "fixtures", "mistral_native", "all_models");

function listJson(): string[] {
  try {
    return readdirSync(ROOT)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}
const files = listJson();

describe.skipIf(files.length === 0)("Mistral — every captured model", () => {
  it.each(files)("%s", (file) => {
    const data = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
    const u = extractMistralNative(data._response, data._model_id);
    expect(u.input).toBeGreaterThan(0);
    expect(u.output).toBeGreaterThan(0);
    expect(u.api).toBe("native");
    expect(u.provider).toBe("mistral");
    expect(u.model).toBe(data._model_id);
  });

  it("usage shape is uniform across the entire catalog", () => {
    const expectedTop = new Set([
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "prompt_tokens_details",
    ]);
    const expectedInner = new Set(["cached_tokens"]);
    for (const file of files) {
      const data = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
      const usage = data._response?.usage ?? {};
      const details = usage.prompt_tokens_details ?? {};
      expect(new Set(Object.keys(usage))).toEqual(expectedTop);
      expect(new Set(Object.keys(details))).toEqual(expectedInner);
    }
  });

  it("vision-capable models do NOT break out image_input separately", () => {
    const visionFiles = files.filter((f) => f.includes("__vision"));
    expect(visionFiles.length).toBeGreaterThan(0);
    for (const file of visionFiles) {
      const data = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
      const u = extractMistralNative(data._response, data._model_id);
      expect(u.image_input).toBe(0);
    }
  });
});
