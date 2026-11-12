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

test("research smoke fixture edits select only their dedicated browser coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "blb-feature-fixture-routing-"));
  try {
    const selectorPath = join(root, "scripts/select-browser-specs.mjs");
    const specPath = join(root, "tests/browser/research-dom-smoke.spec.js");
    const fixturePath = join(root, "tests/pages/research-derived-smoke.html");
    mkdirSync(dirname(selectorPath), { recursive: true });
    mkdirSync(dirname(specPath), { recursive: true });
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(selectorPath, selectorSource);
    const registryPath = join(root, "scripts/ci-routing-registry.mjs");
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, registrySource);
    const policyPath = join(root, "scripts/ci-change-policy.mjs");
    writeFileSync(policyPath, policySource);
    writeFileSync(specPath, "import { test } from '@playwright/test';\ntest('fixture', async () => {});\n");
    writeFileSync(fixturePath, "<html><body>baseline</body></html>\n");
    git(root, "init", "-q");
    git(root, "config", "user.email", "routing-test@example.invalid");
    git(root, "config", "user.name", "Routing test");
    git(root, "add", ".");
    git(root, "commit", "-qm", "baseline");
    writeFileSync(fixturePath, "<html><body>changed research fixture</body></html>\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "research fixture change");
    const base = git(root, "rev-parse", "HEAD~1");
    const output = execFileSync("node", ["scripts/select-browser-specs.mjs", base], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" }
    });
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/research-dom-smoke\.spec\.js/);
    assert.match(output, /reference_required=true/);
    assert.match(output, /unmapped_specs=\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
