import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const referenceWorkflow = readFileSync(new URL("../../.github/workflows/browser-e2e-reference.yml", import.meta.url), "utf8");
const performanceWorkflow = readFileSync(new URL("../../.github/workflows/browser-e2e-performance.yml", import.meta.url), "utf8");

test("browser workflows exclude package-only assets and keep performance paths production-only", () => {
  for (const workflow of [referenceWorkflow, performanceWorkflow]) {
    for (const path of [
      "extension/icons/**",
      "extension/store-assets/**",
      "extension/THIRD-PARTY-NOTICES.txt"
    ]) {
      assert.ok(workflow.includes("- '!" + path + "'"), "missing browser-workflow exclusion: " + path);
    }
    assert.ok(!workflow.includes("- 'regression-suite/**'"), "deterministic regression files must not trigger browser workflows");
  }

  // The reference workflow has a broad scripts/** include, so it must explicitly
  // exclude build-validation tooling. The performance workflow intentionally has
  // no scripts/** include at all: it is restricted to shipped code and manifests.
  assert.ok(referenceWorkflow.includes("- 'scripts/**'"));
  assert.ok(referenceWorkflow.includes("- '!scripts/validate-build.js'"),
    "reference browser workflow must exclude package-only build-validation tooling");
  const performancePaths = performanceWorkflow.split("    paths:\n")[1]?.split("\n  workflow_dispatch:")[0] || "";
  assert.ok(!performancePaths.includes("'scripts/**'") && !performancePaths.includes("'scripts/validate-build.js'"),
    "performance workflow must not include developer tooling in its production-only path filter");
  assert.ok(performancePaths.includes("'extension/**'") &&
    performancePaths.includes("'package.json'") &&
    performancePaths.includes("'package-lock.json'"),
    "performance workflow must remain scoped to shipped extension and production dependency manifests");
});
