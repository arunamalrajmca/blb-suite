import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const selectorSource = readFileSync(new URL("../../scripts/select-browser-specs.mjs", import.meta.url), "utf8");
const registrySource = readFileSync(new URL("../../scripts/ci-routing-registry.mjs", import.meta.url), "utf8");
const policySource = readFileSync(new URL("../../scripts/ci-change-policy.mjs", import.meta.url), "utf8");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runScenario(changedPath) {
  const root = mkdtempSync(join(tmpdir(), "blb-store-routing-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.email", "routing-test@example.invalid");
    git(root, "config", "user.name", "Routing test");
    const selectorPath = join(root, "scripts/select-browser-specs.mjs");
    mkdirSync(dirname(selectorPath), { recursive: true });
    writeFileSync(selectorPath, selectorSource);
    const registryPath = join(root, "scripts/ci-routing-registry.mjs");
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, registrySource);
    const policyPath = join(root, "scripts/ci-change-policy.mjs");
    writeFileSync(policyPath, policySource);
    git(root, "add", ".");
    git(root, "commit", "-qm", "baseline");
    const target = join(root, changedPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "# store-only verification change\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "store-only change");
    const base = git(root, "rev-parse", "HEAD~1");
    return execFileSync("node", ["scripts/select-browser-specs.mjs", base], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const changedPath of [
  "scripts/verify-store-assets.py",
  "scripts/verify-store-branding.py",
  "scripts/verify-store-package.py",
  "scripts/verify-store-submission-assets.py",
  "tests/test_verify_store_package.py",
  "tests/test_verify_store_submission_assets.py",
  "extension/icons/icon16.png",
  "extension/store-assets/branding.png",
  "extension/THIRD-PARTY-NOTICES.txt"
]) {
  test(changedPath + " skips browser regression groups", () => {
    const output = runScenario(changedPath);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /group_a_required=false/);
    assert.match(output, /group_b_required=false/);
    assert.match(output, /reference_required=false/);
    assert.match(output, /changed_specs=\n/);
  });
}
