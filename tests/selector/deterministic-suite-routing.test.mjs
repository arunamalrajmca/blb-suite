import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const selectorSource = readFileSync(new URL("../../scripts/select-browser-specs.mjs", import.meta.url), "utf8");
const classifierSource = readFileSync(new URL("../../scripts/classify-ci-changes.mjs", import.meta.url), "utf8");
const workflowSource = readFileSync(new URL("../../.github/workflows/browser-tests.yml", import.meta.url), "utf8");
const zipWorkflowSource = readFileSync(new URL("../../.github/workflows/zip-integrity.yml", import.meta.url), "utf8");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runScenario(changedPath) {
  const root = mkdtempSync(join(tmpdir(), "blb-deterministic-routing-"));
  try {
    for (const [path, content] of [
      ["scripts/select-browser-specs.mjs", selectorSource],
      ["scripts/classify-ci-changes.mjs", classifierSource]
    ]) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git(root, "init", "-q");
    git(root, "config", "user.email", "routing-test@example.invalid");
    git(root, "config", "user.name", "Routing test");
    git(root, "add", ".");
    git(root, "commit", "-qm", "baseline");
    const target = join(root, changedPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "// deterministic tooling change\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "deterministic tooling change");
    const base = git(root, "rev-parse", "HEAD~1");
    const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" };
    const browser = execFileSync("node", ["scripts/select-browser-specs.mjs", base], { cwd: root, encoding: "utf8", env });
    const classification = execFileSync("node", ["scripts/classify-ci-changes.mjs", base], { cwd: root, encoding: "utf8", env });
    return { browser, classification };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("deterministic regression-suite edits run behavioral gates but skip browser E2E", () => {
  for (const path of [
    "regression-suite/tests/run-regression.mjs",
    "regression-suite/tests/fixtures.json",
    "regression-suite/tests/e2e-matrix.json",
    "regression-suite/tests/kjv-corpus-integrity.mjs"
  ]) {
    const { browser, classification } = runScenario(path);
    assert.match(classification, /runtime_changed=false/, path);
    assert.match(classification, /behavioral_validation_required=true/, path);
    assert.match(classification, /package_validation_required=true/, path);
    assert.match(browser, /full_browser_suite=false/, path);
    assert.match(browser, /group_a_required=false/, path);
    assert.match(browser, /group_b_required=false/, path);
    assert.match(browser, /reference_required=false/, path);
  }
  assert.match(zipWorkflowSource, /scripts\/package-release\.sh/);
  assert.match(zipWorkflowSource, /regression-suite\/Verify-BLB-Zip\.ps1/);
});

test("build and package tooling edits run package validation without browser or behavioral suites", () => {
  for (const path of [
    "scripts/validate-build.js",
    "scripts/package-release.sh",
    "regression-suite/Verify-BLB-Zip.ps1"
  ]) {
    const { browser, classification } = runScenario(path);
    assert.match(classification, /runtime_changed=false/, path);
    assert.match(classification, /behavioral_validation_required=false/, path);
    assert.match(classification, /package_validation_required=true/, path);
    assert.match(browser, /full_browser_suite=false/, path);
    assert.match(browser, /group_a_required=false/, path);
    assert.match(browser, /group_b_required=false/, path);
    assert.match(browser, /reference_required=false/, path);
  }
});

test("deterministic regression changes remain required by the HARD-GATE", () => {
  assert.match(workflowSource, /behavioral_validation_required: \$\{\{ steps\.classify\.outputs\.behavioral_validation_required \}\}/);
  assert.match(workflowSource, /outputs\.behavioral_validation_required == 'true'/);
  assert.match(workflowSource, /outputs\.behavioral_validation_required == 'false'/);
});
