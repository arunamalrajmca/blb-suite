import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const selectorSource = readFileSync(
  new URL("../../scripts/select-browser-specs.mjs", import.meta.url),
  "utf8"
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function put(root, path, content = "// fixture\n") {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "blb-selector-test-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "selector-test@example.invalid");
  git(root, "config", "user.name", "Selector test");
  put(root, "scripts/select-browser-specs.mjs", selectorSource);
  put(root, "extension/omnibox-search-helpers.js");
  put(root, "tests/browser/omnibox-boolean-operators.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/e2e-core-user-actions.spec.js", "import { test } from '@playwright/test';\n");
  put(root, "tests/browser/fixtures.js");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function commitChange(root, path, content) {
  put(root, path, content);
  git(root, "add", path);
  git(root, "commit", "-qm", "scenario change");
}

function select(root, base) {
  return execFileSync("node", ["scripts/select-browser-specs.mjs", base], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" }
  });
}

function withFixture(run) {
  const { root, base } = fixture();
  try { run(root, base); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("mapped feature implementation selects its focused behavioral spec", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/omnibox-search-helpers.js", "// changed\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=tests\/browser\/omnibox-boolean-operators\.spec\.js/);
    assert.match(output, /group_a_required=true/);
  });
});

test("browser-spec-only edit does not launch feature E2E", () => {
  withFixture((root, base) => {
    commitChange(root, "tests/browser/omnibox-boolean-operators.spec.js", "// test-only edit\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=false/);
    assert.match(output, /changed_specs=\n/);
    assert.match(output, /changed_browser_specs=\n/);
    assert.match(output, /group_a_required=false/);
  });
});

test("mixed runtime and browser-spec change selects the whole changed spec", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/omnibox-search-helpers.js", "// changed\n");
    commitChange(root, "tests/browser/omnibox-boolean-operators.spec.js", "// changed with runtime\n");
    const output = select(root, base);
    assert.match(output, /changed_browser_specs=tests\/browser\/omnibox-boolean-operators\.spec\.js/);
    assert.match(output, /group_a_required=true/);
  });
});

test("unknown runtime file conservatively selects broad browser coverage", () => {
  withFixture((root, base) => {
    commitChange(root, "extension/new-runtime-module.js", "// unknown runtime module\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=true/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=true/);
    assert.match(output, /reference_required=true/);
  });
});

test("browser fixture changes select broad coverage", () => {
  withFixture((root, base) => {
    commitChange(root, "tests/browser/fixtures.js", "// fixture changed\n");
    const output = select(root, base);
    assert.match(output, /full_browser_suite=true/);
    assert.match(output, /group_a_required=true/);
    assert.match(output, /group_b_required=true/);
    assert.match(output, /reference_required=true/);
  });
});
