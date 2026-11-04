import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const referenceWorkflow = readFileSync(new URL("../../.github/workflows/browser-e2e-reference.yml", import.meta.url), "utf8");
const performanceWorkflow = readFileSync(new URL("../../.github/workflows/browser-e2e-performance.yml", import.meta.url), "utf8");

test("browser workflows exclude package-only assets and build-validation tooling", () => {
  for (const workflow of [referenceWorkflow, performanceWorkflow]) {
    for (const path of [
      "extension/icons/**",
      "extension/store-assets/**",
      "extension/THIRD-PARTY-NOTICES.txt",
      "scripts/validate-build.js"
    ]) {
      assert.ok(workflow.includes("- '!"+path+"'"), "missing browser-workflow exclusion: " + path);
    }
    assert.ok(!workflow.includes("- 'regression-suite/**'"), "deterministic regression files must not trigger browser workflows");
  }
});
