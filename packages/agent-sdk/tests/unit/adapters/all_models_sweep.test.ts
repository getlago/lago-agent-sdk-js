/** Sweep every captured Bedrock fixture — adapters never crash, dispatch is right. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractBedrockConverse,
  extractBedrockInvoke,
  pickInvokeAdapter,
} from "../../../src/adapters/index.js";

const ROOT = join(__dirname, "fixtures", "bedrock");
const CONV = join(ROOT, "converse");
const INV = join(ROOT, "invoke");

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

const converseFiles = listJson(CONV);
const invokeFiles = listJson(INV);

describe.skipIf(converseFiles.length === 0)("Bedrock Converse — every captured model", () => {
  it.each(converseFiles)("%s", (file) => {
    const data = JSON.parse(readFileSync(join(CONV, file), "utf8"));
    const u = extractBedrockConverse(data._response, data._model_id);
    expect(u.input).toBeGreaterThan(0);
    expect(u.output).toBeGreaterThan(0);
    expect(u.api).toBe("bedrock_converse");
  });
});

describe.skipIf(invokeFiles.length === 0)("Bedrock InvokeModel — every captured model", () => {
  it.each(invokeFiles)("%s", (file) => {
    const data = JSON.parse(readFileSync(join(INV, file), "utf8"));
    const family = pickInvokeAdapter(data._model_id);
    const u = extractBedrockInvoke(data._response, data._model_id);
    expect(u.api).toBe("bedrock_invoke");
    if (family === "mistral_legacy") {
      expect(u.extras._no_usage).toBe(true);
    } else {
      expect(u.input).toBeGreaterThan(0);
      expect(u.output).toBeGreaterThan(0);
    }
  });
});
