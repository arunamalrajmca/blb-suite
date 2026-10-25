#!/usr/bin/env node
/**
 * Select browser E2E coverage for pull requests.
 *
 * On main and manual dispatches, run the complete browser suite. On PRs,
 * select changed spec files when the change is feature-scoped. Changes to CI,
 * test infrastructure, package/manifest configuration, or runtime changes
 * without a corresponding spec stay on the full-suite path.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const base = process.argv[2];
const event = process.env.GITHUB_EVENT_NAME || "";
const ref = process.env.GITHUB_REF || "";
const alwaysFull = event === "workflow_dispatch" || (event === "push" && ref === "refs/heads/main");
const run = (args) => execFileSync("git", args, { encoding: "utf8" }).trimEnd();
let changed = [];
if (!alwaysFull) {
  if (!base || !/^[0-9a-f]{7,40}$/i.test(base)) {
    console.error("Usage: node scripts/select-browser-specs.mjs <base-sha>");
    process.exit(2);
  }
  changed = run(["diff", "--name-only", "--diff-filter=ACDMRT", `${base}...HEAD`])
    .split("\n").filter(Boolean);
}
const specs = changed.filter(path => /^tests\/browser\/[^/]+\.spec\.js$/.test(path)).sort();
const forceFull = alwaysFull || changed.some(path =>
    path.startsWith(".github/workflows/")
    || path.startsWith("scripts/")
    || path === "package.json"
    || path === "package-lock.json"
    || path === "playwright.config.js"
    || path === "playwright.config.ts"
    || path === "tests/browser/fixtures.js"
    || path === "extension/manifest.json"
  );
const nonDocs = changed.filter(path =>
  !/^(?:docs\/|README(?:\.|$)|LICENSE(?:\.|$)|CHANGELOG(?:\.|$)|CONTRIBUTING(?:\.|$)|\.github\/(?:ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\/))/.test(path)
  && !/^(?:store-assets\/|assets\/store\/|extension\/(?:icons|store-assets)\/)/.test(path)
);
const hasRuntimeOrTestChange = nonDocs.length > 0;
const full = forceFull || (hasRuntimeOrTestChange && specs.length === 0);
const selected = specs;
const mappedSpecs = new Set([
  "tests/browser/redirect-source-url-patterns.spec.js",
  "tests/browser/omnibox-boolean-operators.spec.js",
  "tests/browser/redirect-source-url-browser.spec.js",
  "tests/browser/e2e-core-user-actions.spec.js",
  "tests/browser/kings-bible-collector-behavior.spec.js",
  "tests/browser/feature-lifecycle-regressions.spec.js",
  "tests/browser/study-backup-restore.spec.js",
  "tests/browser/extension.spec.js",
  "tests/browser/redirect-hostnames.spec.js",
  "tests/browser/blb-non-kjv-redirect.spec.js",
  "tests/browser/scripttagger-global-injection.spec.js",
  "tests/browser/shared-regex-patterns.spec.js",
  "tests/browser/rediscover-sagacity-button.spec.js",
  "tests/browser/research-dom-smoke.spec.js"
]);
const separatelyManagedSpecs = new Set([
  "tests/browser/multiverse-tab-reuse.spec.js",
  "tests/browser/performance.spec.js"
]);
const unmapped = selected.filter(path => !mappedSpecs.has(path) && !separatelyManagedSpecs.has(path));
const has = (...names) => full || selected.some(path => names.includes(path));
const output = process.env.GITHUB_OUTPUT;
const values = {
  full_browser_suite: String(full),
  changed_specs: selected.join(","),
  unmapped_specs: unmapped.join(","),
  group_a_required: String(has(
    "tests/browser/redirect-source-url-patterns.spec.js",
    "tests/browser/omnibox-boolean-operators.spec.js",
    "tests/browser/redirect-source-url-browser.spec.js",
    "tests/browser/e2e-core-user-actions.spec.js",
    "tests/browser/kings-bible-collector-behavior.spec.js",
    "tests/browser/feature-lifecycle-regressions.spec.js",
    "tests/browser/study-backup-restore.spec.js",
    "tests/browser/extension.spec.js"
  ) || unmapped.length > 0),
  group_b_required: String(has(
    "tests/browser/redirect-hostnames.spec.js",
    "tests/browser/blb-non-kjv-redirect.spec.js",
    "tests/browser/scripttagger-global-injection.spec.js",
    "tests/browser/e2e-core-user-actions.spec.js"
  )),
  reference_required: String(has(
    "tests/browser/extension.spec.js",
    "tests/browser/shared-regex-patterns.spec.js",
    "tests/browser/rediscover-sagacity-button.spec.js",
    "tests/browser/research-dom-smoke.spec.js"
  ))
};
if (output) appendFileSync(output, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(""));
for (const [key,value] of Object.entries(values)) console.log(`${key}=${value}`);
console.log(`changed_files=${changed.length}`);
if (selected.length) console.log("selected_specs:\n- " + selected.join("\n- "));
