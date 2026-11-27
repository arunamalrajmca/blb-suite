import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isNonRuntimePath, requiresPackageValidation } from "../../scripts/ci-change-policy.mjs";

test("repository AST audit analyzers and their fixtures are validated separately from package checks", () => {
  const auditPaths = [
    "scripts/ast-symbol-reference-audit.js",
    "scripts/ast-symbol-reference-audit.test.js",
    "scripts/ast-repository-reachability-audit.js",
    "scripts/ast-repository-reachability-audit.test.js",
    "scripts/ast-owner-aware-node-reachability-audit.js",
    "scripts/ast-owner-aware-node-reachability-audit.test.js",
    "scripts/ast-cross-module-dynamic-reachability-audit.js",
    "scripts/ast-cross-module-dynamic-reachability-audit.test.js",
    "scripts/ast-runtime-flow-reachability-audit.js",
    "scripts/ast-runtime-flow-reachability-audit.test.js",
    "scripts/ast-unified-dynamic-runtime-reachability-audit.js",
    "scripts/ast-unified-dynamic-runtime-reachability-audit.test.js",
    "scripts/ast-computed-property-reachability-audit.js",
    "scripts/ast-computed-property-reachability-audit.test.js",
    "scripts/ast-executable-source-coverage-audit.js",
    "scripts/ast-executable-source-coverage-audit.test.js",
    "scripts/ast-runtime-metaprogramming-uncertainty-audit.js",
    "scripts/ast-runtime-metaprogramming-uncertainty-audit.test.js"
  ];
  for (const path of auditPaths) {
    assert.equal(isNonRuntimePath(path), true, path);
    assert.equal(requiresPackageValidation(path), false, path);
  }
  assert.equal(isNonRuntimePath("scripts/ast-unrecognized-audit.js"), false);
  assert.equal(requiresPackageValidation("scripts/ast-unrecognized-audit.js"), false);
});

test("the shared CI path policy keeps documentation, CI, selector and browser-spec edits non-runtime", () => {
  for (const path of [
    "README.md",
    "docs/ci-routing.md",
    "tests/selector/browser-selector-decisions.test.mjs",
    "tests/browser/omnibox-command-routing.spec.js",
    "scripts/ci-routing-registry.mjs",
    "scripts/test-file-inventory-helpers.test.mjs"
  ]) {
    assert.equal(isNonRuntimePath(path), true, path);
  }
});

test("store-only assets and dedicated store verifiers remain non-runtime", () => {
  for (const path of [
    "store-assets/promo-tile.png",
    "assets/store/listing.png",
    "extension/icons/icon-128.png",
    "scripts/verify-store-assets.py",
    "tests/test_verify_store_package.py"
  ]) {
    assert.equal(isNonRuntimePath(path), true, path);
  }
});

test("unknown paths and shared extension code are never classified as non-runtime", () => {
  for (const path of [
    "extension/background.js",
    "extension/content.js",
    "extension/reference-core.js",
    "extension/new-runtime-module.js",
    "scripts/new-ci-helper.mjs",
    "tests/browser/fixtures.js",
    "package-lock.json"
  ]) {
    assert.equal(isNonRuntimePath(path), false, path);
  }
});

test("package validation ownership is centralized alongside runtime classification", () => {
  for (const path of [
    "tests/selector/ci-change-policy.test.mjs",
    "scripts/ci-routing-registry.mjs",
    "package-lock.json",
    "extension/manifest.json"
  ]) {
    assert.equal(requiresPackageValidation(path), true, path);
  }
  assert.equal(requiresPackageValidation("README.md"), false);
});

test("both CI selectors consume the same path-policy module", () => {
  const classifier = readFileSync(new URL("../../scripts/classify-ci-changes.mjs", import.meta.url), "utf8");
  const browserSelector = readFileSync(new URL("../../scripts/select-browser-specs.mjs", import.meta.url), "utf8");
  assert.match(classifier, /from "\.\/ci-change-policy\.mjs"/);
  assert.match(browserSelector, /from "\.\/ci-change-policy\.mjs"/);
});

test("repository AST audits run separately from package validation with bounded concurrency", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/browser-tests.yml", import.meta.url), "utf8");
  const auditStart = workflow.indexOf("  repository-ast-audits:");
  const packageStart = workflow.indexOf("  regression-package:");
  const behavioralStart = workflow.indexOf("  regression-behavioral:");
  const summaryStart = workflow.indexOf("  regression-gate-summary:");
  assert.ok(auditStart >= 0 && packageStart > auditStart && behavioralStart > packageStart);
  const auditJob = workflow.slice(auditStart, packageStart);
  const packageJob = workflow.slice(packageStart, behavioralStart);
  const summaryJob = workflow.slice(summaryStart);
  assert.match(auditJob, /Run selected repository-wide AST audits concurrently/);
  assert.match(auditJob, /if \(\( active >= 4 \)\)/);
  assert.match(auditJob, /wait -n/);
  assert.ok(auditJob.includes('tee "$log_file" | sed -u'));
  assert.doesNotMatch(packageJob, /Classify repository-wide AST audit scope|Install pinned AST audit dependencies|Run selected repository-wide AST audits concurrently/);
  assert.match(packageJob, /name: Package validation/);
  assert.match(packageJob, /needs\.change-detection\.outputs\.package_regression_required/);
  assert.match(summaryJob, /repository-ast-audits/);
});

test("workflow-only validation contracts do not force package regression validation", () => {
  const workflowPath = ".github/workflows/browser-e2e-groups.yml";
  assert.equal(isNonRuntimePath(workflowPath), true);
  assert.equal(requiresPackageValidation(workflowPath), false);
});
