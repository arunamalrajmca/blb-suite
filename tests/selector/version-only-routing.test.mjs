import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const selectorSource = readFileSync(new URL("../../scripts/select-browser-specs.mjs", import.meta.url), "utf8");
const classifierSource = readFileSync(new URL("../../scripts/classify-ci-changes.mjs", import.meta.url), "utf8");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function scenario(path, before, after) {
  const root = mkdtempSync(join(tmpdir(), "blb-version-routing-"));
  try {
    for (const [file, content] of [
      ["scripts/select-browser-specs.mjs", selectorSource],
      ["scripts/classify-ci-changes.mjs", classifierSource],
      ["package.json", JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "before" } }) + "\n"],
      ["extension/manifest.json", JSON.stringify({ manifest_version: 3, version: "1.0.0", permissions: ["tabs"] }) + "\n"]
    ]) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git(root, "init", "-q");
    git(root, "config", "user.email", "routing-test@example.invalid");
    git(root, "config", "user.name", "Routing test");
    git(root, "add", ".");
    git(root, "commit", "-qm", "baseline");
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(after) + "\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "metadata change");
    const base = git(root, "rev-parse", "HEAD~1");
    const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" };
    const browser = execFileSync("node", ["scripts/select-browser-specs.mjs", base], { cwd: root, encoding: "utf8", env });
    const classification = execFileSync("node", ["scripts/classify-ci-changes.mjs", base], { cwd: root, encoding: "utf8", env });
    return { browser, classification };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("package and manifest version-only edits retain package validation without browser E2E", () => {
  const packageResult = scenario("package.json",
    { name: "fixture", version: "1.0.0", scripts: { test: "before" } },
    { name: "fixture", version: "1.0.1", scripts: { test: "before" } });
  const manifestResult = scenario("extension/manifest.json",
    { manifest_version: 3, version: "1.0.0", permissions: ["tabs"] },
    { manifest_version: 3, version: "1.0.1", permissions: ["tabs"] });
  for (const { browser, classification } of [packageResult, manifestResult]) {
    assert.match(classification, /runtime_changed=false/);
    assert.match(classification, /behavioral_validation_required=false/);
    assert.match(classification, /package_validation_required=true/);
    assert.match(browser, /full_browser_suite=false/);
    assert.match(browser, /group_a_required=false/);
    assert.match(browser, /group_b_required=false/);
    assert.match(browser, /reference_required=false/);
  }
});

test("non-version package or manifest metadata edits remain broad runtime changes", () => {
  const packageResult = scenario("package.json",
    { name: "fixture", version: "1.0.0", scripts: { test: "before" } },
    { name: "fixture", version: "1.0.0", scripts: { test: "after" } });
  const manifestResult = scenario("extension/manifest.json",
    { manifest_version: 3, version: "1.0.0", permissions: ["tabs"] },
    { manifest_version: 3, version: "1.0.0", permissions: ["tabs", "storage"] });
  for (const { browser, classification } of [packageResult, manifestResult]) {
    assert.match(classification, /runtime_changed=true/);
    assert.match(classification, /behavioral_validation_required=true/);
    assert.match(browser, /full_browser_suite=true/);
  }
});
