import test from "node:test";
import {
  featureSpecs, mappedSpecs, separatelyManagedSpecs, groupARequiredSpecs,
  groupAExecutionSpecs, groupBRequiredSpecs, referenceRequiredSpecs,
  referenceDelegatedSpecs, studySessionSpecs
} from "../../scripts/ci-routing-registry.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const selectorSource = readFileSync(new URL("../../scripts/select-browser-specs.mjs", import.meta.url), "utf8");
const registrySource = readFileSync(new URL("../../scripts/ci-routing-registry.mjs", import.meta.url), "utf8");
const classifierSource = readFileSync(new URL("../../scripts/classify-ci-changes.mjs", import.meta.url), "utf8");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runScenario(changedPath) {
  const root = mkdtempSync(join(tmpdir(), "blb-contract-routing-"));
  try {
    for (const [path, content] of [
      ["scripts/select-browser-specs.mjs", selectorSource],
      ["scripts/ci-routing-registry.mjs", registrySource],
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
    writeFileSync(target, "// contract-test-only change\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "contract-test-only change");
    const base = git(root, "rev-parse", "HEAD~1");
    const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" };
    const browser = execFileSync("node", ["scripts/select-browser-specs.mjs", base], { cwd: root, encoding: "utf8", env });
    const classification = execFileSync("node", ["scripts/classify-ci-changes.mjs", base], { cwd: root, encoding: "utf8", env });
    return { browser, classification };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("unknown test-script paths retain conservative full browser coverage", () => {
  const { browser, classification } = runScenario("scripts/test-unmapped.js");
  assert.match(classification, /runtime_changed=true/);
  assert.match(classification, /behavioral_validation_required=true/);
  assert.match(classification, /package_validation_required=true/);
  assert.match(browser, /full_browser_suite=true/);
  assert.match(browser, /group_a_required=true/);
  assert.match(browser, /group_b_required=true/);
  assert.match(browser, /reference_required=true/);
});

for (const path of [
  "scripts/test-cross-feature-contracts.js",
  "scripts/test-extraction-safety-contracts.js",
  "scripts/test-module-loading-contracts.js",
  "scripts/test-multiverse-reference-helpers.js",
  "scripts/test-omnibox-boolean-operators.js",
  "scripts/test-omnibox-gibberish-filter.js",
  "scripts/test-omnibox-search-normalization.js",
  "scripts/test-reference-core-characterization.js",
  "scripts/test-selection-marker-stripping.js",
  "scripts/test-selection-text-normalization.js",
  "scripts/test-single-word-selection-normalization.js",
  "scripts/test-study-session-export.js",
  "scripts/test-study-session-normalization.js"
]) {
  test(path + " requires package validation without browser E2E", () => {
    const { browser, classification } = runScenario(path);
    assert.match(classification, /runtime_changed=false/, path);
    assert.match(classification, /package_validation_required=true/, path);
    assert.match(browser, /full_browser_suite=false/, path);
    assert.match(browser, /changed_specs=\n/, path);
    assert.match(browser, /group_a_required=false/, path);
    assert.match(browser, /group_b_required=false/, path);
    assert.match(browser, /reference_required=false/, path);
  });
}


test("every feature-owned browser regression has an explicit CI classification", () => {
  const classified = new Set([...mappedSpecs, ...separatelyManagedSpecs]);
  const missing = [...new Set(featureSpecs.flatMap(group => group.specs))]
    .filter(spec => !classified.has(spec))
    .sort();
  assert.deepEqual(missing, [], "feature routing must not select specs omitted from CI ownership classification");

  const ownershipSets = [
    groupARequiredSpecs, groupAExecutionSpecs, groupBRequiredSpecs,
    referenceRequiredSpecs, referenceDelegatedSpecs, studySessionSpecs
  ];
  for (const ownership of ownershipSets) {
    for (const spec of ownership) {
      assert.ok(classified.has(spec), "gate ownership must refer to a classified browser spec: " + spec);
    }
  }
  for (const spec of groupAExecutionSpecs) {
    assert.ok(groupARequiredSpecs.has(spec), "Group A execution must be a subset of Group A ownership");
    assert.ok(!referenceDelegatedSpecs.has(spec), "Reference-delegated specs cannot be Group A execution");
    assert.ok(!studySessionSpecs.has(spec), "Study Sessions specs cannot be Group A execution");
  }
});
