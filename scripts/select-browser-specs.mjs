#!/usr/bin/env node
/**
 * Conservative feature-aware browser coverage selector.
 *
 * Runtime files with an explicit feature mapping select the corresponding
 * existing browser specs. Shared-core, workflow/test-infrastructure, package,
 * manifest, and unknown changes use the full suite. This intentionally keeps
 * the current test commands and browser-install/cache workflow unchanged.
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

const specs = new Set(changed.filter(path => /^tests\/browser\/[^/]+\.spec\.js$/.test(path)));
// Any changed browser spec triggers the full applicable browser suite. A spec can
// contain cross-feature assertions, and running only its mapped/grep-selected
// cases risks missing valid regressions. Keep runtime-file routing conservative.
const forceFull = alwaysFull || changed.some(path =>
  /^tests\\/browser\\/[^/]+\\.spec\\.js$/.test(path)
) || changed.some(path =>
  path.startsWith(".github/workflows/")
  || path.startsWith("scripts/")
  || path.startsWith("regression-suite/")
  || (path.startsWith("tests/") && !/^tests\/browser\/[^/]+\.spec\.js$/.test(path))
  || path === "package.json"
  || path === "package-lock.json"
  || path === "playwright.config.js"
  || path === "playwright.config.ts"
  || path === "extension/manifest.json"
  || path === "extension/background.js"
  || path === "extension/content.js"
  || path === "extension/reference-core.js"
  || path === "extension/regex-patterns.js"
  || path === "extension/books.js"
  || path === "extension/book-aliases.js"
  || path.startsWith("extension/kjv-corpus-")
  || path === "extension/case-sensitive-search-core.js"
  || path === "extension/case-sensitive-routing.js"
  || path === "tests/browser/fixtures.js"
);

// Explicit, conservative file-to-feature map. Mapped files only narrow browser
// coverage when the implementation is genuinely feature-scoped.
const featureSpecs = [
  {
    paths: ["extension/redirect-bibleref-ranges.js", "extension/redirect-christianity-main-world.js"],
    specs: ["tests/browser/redirect-source-url-patterns.spec.js", "tests/browser/redirect-source-url-browser.spec.js", "tests/browser/redirect-hostnames.spec.js", "tests/browser/blb-non-kjv-redirect.spec.js"]
  },
  {
    paths: ["extension/redirect-scripttagger.js"],
    specs: ["tests/browser/scripttagger-global-injection.spec.js"]
  },
  {
    paths: ["extension/multiverse-post.html", "extension/multiverse-post.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js", "tests/browser/multiverse-tab-reuse.spec.js"]
  },
  {
    paths: ["extension/popup.html", "extension/popup.js"],
    specs: ["tests/browser/site-feature-defaults.spec.js", "tests/browser/study-session-popup-ui-regression.spec.js", "tests/browser/study-backup-restore.spec.js", "tests/browser/feature-lifecycle-regressions.spec.js"]
  },
  {
    paths: ["extension/Tutorial.html", "extension/Tutorial.js"],
    specs: []
  }
];
const ignoredNonRuntime = path =>
  /^(?:docs\/|README(?:\.|$)|LICENSE(?:\.|$)|CHANGELOG(?:\.|$)|CONTRIBUTING(?:\.|$)|\.github\/(?:ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\/))/.test(path)
  || /^(?:store-assets\/|assets\/store\/|extension\/(?:icons|store-assets)\/)/.test(path)
  || /^extension\/(?:Tutorial\.html|Tutorial\.js|THIRD-PARTY-NOTICES\.txt)$/.test(path);

let unknownRuntime = false;
for (const path of changed) {
  if (ignoredNonRuntime(path) || /^tests\/browser\/[^/]+\.spec\.js$/.test(path)) continue;
  const mapped = featureSpecs.find(group => group.paths.includes(path));
  if (mapped) {
    for (const spec of mapped.specs) specs.add(spec);
    continue;
  }
  if (!forceFull) unknownRuntime = true;
}

const full = forceFull || unknownRuntime;
const selected = [...specs].sort();
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
  "tests/browser/research-dom-smoke.spec.js",
  "tests/browser/multiverse-tab-reuse.spec.js",
  "tests/browser/performance.spec.js",
  "tests/browser/site-feature-defaults.spec.js",
  "tests/browser/study-session-popup-ui-regression.spec.js"
]);
const separatelyManagedSpecs = new Set(["tests/browser/multiverse-tab-reuse.spec.js", "tests/browser/performance.spec.js"]);
const unmapped = selected.filter(path => !mappedSpecs.has(path) && !separatelyManagedSpecs.has(path));
const has = (...names) => full || selected.some(path => names.includes(path));
const values = {
  full_browser_suite: String(full),
  changed_specs: selected.join(","),
  unmapped_specs: unmapped.join(","),
  extension_spec_required: String(full || selected.includes("tests/browser/extension.spec.js")),
  group_a_required: String(has(
    "tests/browser/redirect-source-url-patterns.spec.js",
    "tests/browser/omnibox-boolean-operators.spec.js",
    "tests/browser/redirect-source-url-browser.spec.js",
    "tests/browser/e2e-core-user-actions.spec.js",
    "tests/browser/kings-bible-collector-behavior.spec.js",
    "tests/browser/feature-lifecycle-regressions.spec.js",
    "tests/browser/study-backup-restore.spec.js",
    "tests/browser/extension.spec.js",
    "tests/browser/site-feature-defaults.spec.js",
    "tests/browser/study-session-popup-ui-regression.spec.js"
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
    "tests/browser/research-dom-smoke.spec.js",
    "tests/browser/redirect-source-url-patterns.spec.js",
    "tests/browser/redirect-source-url-browser.spec.js"
  ))
};
const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(""));
for (const [key,value] of Object.entries(values)) console.log(`${key}=${value}`);
console.log(`changed_files=${changed.length}`);
if (selected.length) console.log("selected_specs:\n- " + selected.join("\n- "));
