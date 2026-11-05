#!/usr/bin/env node
/**
 * Conservative feature-aware browser coverage selector.
 *
 * Runtime files with an explicit feature mapping select the corresponding browser specs.
 * Shared-core, dependency, non-version package/manifest, and unknown runtime changes use the full suite.
 * Known CI, deterministic-test, and package-only tooling changes skip browser E2E while retaining their own gates.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { featureSpecs, mappedSpecs, separatelyManagedSpecs, studySessionSpecs } from "./ci-routing-registry.mjs";

const base = process.argv[2];
const event = process.env.GITHUB_EVENT_NAME || "";
const ref = process.env.GITHUB_REF || "";
// Main pushes should select coverage from the pushed diff, just like PRs. Keep a full run for manual dispatches and first pushes where GitHub provides an all-zero before SHA.
const alwaysFull = event === "workflow_dispatch" || (event === "push" && ref === "refs/heads/main" && (!base || /^0+$/.test(base)));
const run = (args) => execFileSync("git", args, { encoding: "utf8" }).trimEnd();
function readAt(ref, path) {
  try { return run(["show", `${ref}:${path}`]); }
  catch { return null; }
}
function sameExceptVersion(path) {
  const before = readAt(base, path);
  const after = readAt("HEAD", path);
  if (before === null || after === null) return false;
  try {
    const a = JSON.parse(before);
    const b = JSON.parse(after);
    if (typeof a.version !== "string" || typeof b.version !== "string") return false;
    delete a.version;
    delete b.version;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}
let changed = [];
if (!alwaysFull) {
  if (!base || !/^[0-9a-f]{7,40}$/i.test(base)) {
    console.error("Usage: node scripts/select-browser-specs.mjs <base-sha>");
    process.exit(2);
  }
  changed = run(["diff", "--name-only", "--diff-filter=ACDMRT", `${base}...HEAD`])
    .split("\n").filter(Boolean);
}

const browserSpecPattern = /^tests\/browser\/[^/]+\.spec\.js$/;
const existingBrowserSpecs = new Set(run(["ls-tree", "-r", "--name-only", "HEAD", "--", "tests/browser"]).split("\n").filter(Boolean));
// Test-file edits alone must not launch feature E2E suites. Those suites are
// selected by production-file changes below; this prevents a double-click test
// edit, for example, from triggering double-click E2E when production is untouched.
// An explicit workflow_dispatch or main push remains a full verification run.
const changedBrowserSpecs = [];
const specs = new Set();
const ignoredNonRuntime = path =>
  /^(?:docs\/|README(?:\.|$)|LICENSE(?:\.|$)|CHANGELOG(?:\.|$)|CONTRIBUTING(?:\.|$)|\.github\/(?:workflows\/|ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\/))/.test(path)
  || /^(?:store-assets\/|assets\/store\/|extension\/(?:icons|store-assets)\/)/.test(path)
  || /^extension\/THIRD-PARTY-NOTICES\.txt$/.test(path)
  || /^scripts\/(?:classify-ci-changes|select-browser-specs|select-reference-matrix)\.mjs$/.test(path)
  || path === "scripts/test-ci-routing-selector.js"
  || /^scripts\/test-(?:cross-feature-contracts|extraction-safety-contracts|module-loading-contracts|multiverse-reference-helpers|omnibox-boolean-operators|omnibox-gibberish-filter|omnibox-search-normalization|reference-core-characterization|selection-marker-stripping|selection-text-normalization|single-word-selection-normalization|study-session-export|study-session-normalization)\.js$/i.test(path)
  // Dedicated store verifiers have their own workflows and do not affect runtime browser behavior.
  || /^scripts\/verify-store-(?:assets|branding|package|submission-assets)\.py$/.test(path)
  || /^tests\/test_verify_store_(?:package|submission_assets)\.py$/.test(path)
  // Cross-browser diagnostic harness; it validates the test environment, not extension behavior.
  || path === "scripts/test-popup-cross-browser-rendering.js"
  || path === "scripts/reference-e2e-matrix.json"
  || path === "scripts/package-release.sh"
  || path === "scripts/validate-build.js"
  || path === "regression-suite/Verify-BLB-Zip.ps1"
  || path === "regression-suite/Run-BLB-Regression.ps1"
  || path === "regression-suite/README.md"
  || /^regression-suite\/tests\//.test(path)
  || /^tests\/selector\//.test(path);
// Shared-core, dependency, non-version package/manifest, and unknown runtime
// changes remain conservative and may require the full applicable browser suite.
// Shared background changes remain broad by default. Narrow only the exact, isolated
// omnibox runtime + regression-spec pair so an unrelated core E2E failure cannot
// block that independently covered fix. Background-only or mixed changes stay full.
const focusedOmniboxBackgroundChange = changed.length === 2
  && changed.includes("extension/background.js")
  && changed.includes("tests/browser/omnibox-command-routing.spec.js");
const forceFull = alwaysFull || changed.some(path =>
  !ignoredNonRuntime(path) && (
    (path.startsWith("scripts/") && !/^scripts\/(?:classify-ci-changes|select-browser-specs|select-reference-matrix)\.mjs$/.test(path) && path !== "scripts/test-ci-routing-selector.js" && path !== "scripts/test-popup-cross-browser-rendering.js" && path !== "scripts/reference-e2e-matrix.json")
    || path.startsWith("regression-suite/")
    || (path.startsWith("tests/") && !/^tests\/selector\//.test(path) && !/^tests\/browser\/[^/]+\.spec\.js$/.test(path) && path !== "tests/pages/research-derived-smoke.html")
    || ((path === "package.json" || path === "extension/manifest.json") && !sameExceptVersion(path))
    || path === "package-lock.json"
    || path === "playwright.config.js"
    || path === "playwright.config.ts"
    || (path === "extension/background.js" && !focusedOmniboxBackgroundChange)
    || path === "extension/content.js"
    || path === "extension/reference-core.js"
    || path === "extension/regex-patterns.js"
    || path === "extension/books.js"
    || path === "extension/book-aliases.js"
    || path.startsWith("extension/kjv-corpus-")
    || path === "extension/case-sensitive-search-core.js"
    || path === "extension/case-sensitive-routing.js"
    || path === "tests/browser/fixtures.js"
  )
);

// Explicit, conservative file-to-feature map. Mapped files only narrow browser
// coverage when the implementation is genuinely feature-scoped.



let unknownRuntime = false;
const hasRuntimeChangeAlongsideBrowserSpec = changed.some(path =>
  !ignoredNonRuntime(path) && !browserSpecPattern.test(path)
);
for (const path of changed) {
  if (browserSpecPattern.test(path)) {
    // A test-only edit must not trigger E2E by itself, but when production code
    // changes in the same diff, run the changed spec alongside mapped coverage.
    if (hasRuntimeChangeAlongsideBrowserSpec && existingBrowserSpecs.has(path)) changedBrowserSpecs.push(path);
    continue;
  }
  if (ignoredNonRuntime(path)) continue;
  if ((path === "package.json" || path === "extension/manifest.json") && sameExceptVersion(path)) continue;
  const mapped = featureSpecs.find(group => group.paths.includes(path));
  if (mapped) {
    for (const spec of mapped.specs) specs.add(spec);
    continue;
  }
  if (!forceFull) unknownRuntime = true;
}

const missingMappedSpecs = [...specs].filter(path => !existingBrowserSpecs.has(path));
// A stale mapping must never silently drop behavioral coverage. Fall back to
// the full suite if any mapped target no longer exists in the checked-out tree.
const full = forceFull || unknownRuntime || missingMappedSpecs.length > 0;
const selected = [...specs].filter(path => existingBrowserSpecs.has(path)).sort();


const unmapped = selected.filter(path => !mappedSpecs.has(path) && !separatelyManagedSpecs.has(path));
const has = (...names) => full || selected.some(path => names.includes(path));


const values = {
  full_browser_suite: String(full),
  changed_specs: selected.join(","),
  changed_browser_specs: changedBrowserSpecs.join(","),
  unmapped_specs: unmapped.join(","),
  extension_spec_required: String(full || selected.includes("tests/browser/extension.spec.js")),
  group_a_required: String(has(
    "tests/browser/redirect-source-url-patterns.spec.js",
    "tests/browser/omnibox-boolean-operators.spec.js",
    "tests/browser/e2e-core-user-actions.spec.js",
    "tests/browser/multiverse-contiguous-range-routing.spec.js",
    "tests/browser/multiverse-disjoint-chapter-post.spec.js",
    "tests/browser/multiverse-tool-view.spec.js",
    "tests/browser/multiverse-handoff.spec.js",
    "tests/browser/blb-passive-new-tab-targets.spec.js",
    "tests/browser/source-page-collector-behavior.spec.js",
    "tests/browser/blb-verse-link-navigation.spec.js",
    "tests/browser/criteria-search-navigation.spec.js",
    "tests/browser/kings-bible-collector-behavior.spec.js",
    "tests/browser/webster-collector-behavior.spec.js",
    "tests/browser/blb-auto-hyperlinker.spec.js",
    "tests/browser/blb-draggable-button.spec.js",
    "tests/browser/case-sensitive-routing-behavior.spec.js",
    "tests/browser/extension.spec.js",
    "tests/browser/known-host-extension.spec.js",
    "tests/browser/pr-422-feature-regressions.spec.js",
   
    "tests/browser/site-feature-defaults.spec.js",
  ) || unmapped.length > 0 || changedBrowserSpecs.some(path => !studySessionSpecs.has(path))),
  study_sessions_required: String(full || [...selected, ...changedBrowserSpecs].some(path => studySessionSpecs.has(path))),
  group_b_required: String(has(
    "tests/browser/redirect-hostnames.spec.js",
    "tests/browser/blb-non-kjv-redirect.spec.js",
    "tests/browser/scripttagger-global-injection.spec.js"
  )),
  reference_required: String(has(
    "tests/browser/extension.spec.js",
    "tests/browser/known-host-extension.spec.js",
    "tests/browser/pr-422-feature-regressions.spec.js",
   
    "tests/browser/multiverse-contiguous-range-routing.spec.js",
    "tests/browser/multiverse-disjoint-chapter-post.spec.js",
    "tests/browser/shared-regex-patterns.spec.js",
    "tests/browser/rediscover-sagacity-button.spec.js",
    "tests/browser/research-dom-smoke.spec.js",
    "tests/browser/redirect-source-url-patterns.spec.js",
    "tests/browser/redirect-toggle-isolation.spec.js",
    "tests/browser/multiverse-clipboard-reference-pattern.spec.js",
    "tests/browser/popup-master-toggle-regression.spec.js",
    "tests/browser/facebook-selection-parser.spec.js",
    "tests/browser/substack-selection-parser.spec.js",
    "tests/browser/omnibox-command-routing.spec.js",
    "tests/browser/pdf-selection-regressions.spec.js"
  ))
};
const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(""));
for (const [key,value] of Object.entries(values)) console.log(`${key}=${value}`);
console.log(`changed_files=${changed.length}`);
if (selected.length) console.log("selected_specs:\n- " + selected.join("\n- "));
if (missingMappedSpecs.length) console.log("missing_mapped_specs:\n- " + missingMappedSpecs.join("\n- "));
