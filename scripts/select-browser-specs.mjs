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
import {
  featureSpecs, mappedSpecs, separatelyManagedSpecs, studySessionSpecs,
  groupARequiredSpecs, groupBRequiredSpecs, referenceRequiredSpecs, referenceDelegatedSpecs
} from "./ci-routing-registry.mjs";
import { isNonRuntimePath } from "./ci-change-policy.mjs";

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

const browserSpecPattern = new RegExp("^tests/browser/[^/]+\\.spec\\.js$");
// A spec whose only diff is removed lines does not need to execute: runtime
// changes are covered by mapped specs, while added/modified test content still runs.
function hasAddedSpecLines(path) {
  const row = run(["diff", "--numstat", base + "...HEAD", "--", path]).split("\n").find(Boolean);
  if (!row) return false;
  const added = row.split("\t", 1)[0];
  return added !== "0" && added !== "-";
}
const existingBrowserSpecs = new Set(run(["ls-tree", "-r", "--name-only", "HEAD", "--", "tests/browser"]).split("\n").filter(Boolean));
// Test-file edits alone must not launch feature E2E suites. Those suites are
// selected by production-file changes below; this prevents a double-click test
// edit, for example, from triggering double-click E2E when production is untouched.
// An explicit workflow_dispatch or main push remains a full verification run.
const changedBrowserSpecs = [];
const specs = new Set();
const ignoredNonRuntime = isNonRuntimePath;
// Shared-core, dependency, non-version package/manifest, and unknown runtime
// changes remain conservative and may require the full applicable browser suite.
// Shared background changes remain broad by default. Narrow only the exact, isolated
// omnibox runtime + regression-spec pair so an unrelated core E2E failure cannot
// block that independently covered fix. Background-only or mixed changes stay full.
const focusedOmniboxBackgroundChange = changed.length === 2
  && changed.includes("extension/background.js")
  && changed.includes("tests/browser/omnibox-command-routing.spec.js");
const focusedSourcePageRuntimeChange = changed.filter(path =>
  !ignoredNonRuntime(path) && !browserSpecPattern.test(path)
).length === 1
  && changed.includes("extension/background.js")
  && changed.includes("tests/browser/source-page-button-redirect-separation.spec.js")
  && changed.includes("tests/browser/scripttagger-global-injection.spec.js");
const forceFull = alwaysFull || changed.some(path =>
  !ignoredNonRuntime(path) && (
    (path.startsWith("scripts/") && !/^scripts\/(?:classify-ci-changes|select-browser-specs|select-reference-matrix|ci-routing-registry|ci-change-policy)\.mjs$/.test(path) && path !== "scripts/test-ci-routing-selector.js" && path !== "scripts/test-popup-cross-browser-rendering.js" && path !== "scripts/reference-e2e-matrix.json")
    || path.startsWith("regression-suite/")
    || (path.startsWith("tests/") && !/^tests\/selector\//.test(path) && !/^tests\/browser\/[^/]+\.spec\.js$/.test(path) && path !== "tests/pages/research-derived-smoke.html")
    || ((path === "package.json" || path === "extension/manifest.json") && !sameExceptVersion(path))
    || path === "package-lock.json"
    || path === "playwright.config.js"
    || path === "playwright.config.ts"
    || (path === "extension/background.js" && !focusedOmniboxBackgroundChange && !focusedSourcePageRuntimeChange)
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
    // This regression is deliberately matrix-managed, but test-only edits to
    // it must still execute its focused reference-matrix job. Otherwise a
    // failing reproduction can be edited without ever rerunning that test.
    if ((path === "tests/browser/source-page-button-redirect-separation.spec.js" ||
         (focusedSourcePageRuntimeChange && path === "tests/browser/scripttagger-global-injection.spec.js")) &&
        existingBrowserSpecs.has(path) && hasAddedSpecLines(path)) {
      // Both regressions have dedicated workflow steps: the source-page
      // refresh matrix and Group B ScriptTagger injection. Keep them out of
      // changed_browser_specs so the dedicated jobs do not suppress themselves.
      specs.add(path);
      continue;
    }
    // A test-only edit must not trigger E2E by itself, but when production code
    // changes in the same diff, run the changed spec alongside mapped coverage.
    if (hasRuntimeChangeAlongsideBrowserSpec && existingBrowserSpecs.has(path) &&
        hasAddedSpecLines(path) &&
        path !== "tests/browser/omnibox-command-routing.spec.js" &&
        path !== "tests/browser/source-page-button-redirect-separation.spec.js") {
      changedBrowserSpecs.push(path);
    }
    continue;
  }
  if (ignoredNonRuntime(path)) continue;
  if ((path === "package.json" || path === "extension/manifest.json") && sameExceptVersion(path)) continue;
  if (path === "extension/background.js" && focusedSourcePageRuntimeChange) {
    specs.add("tests/browser/source-page-button-redirect-separation.spec.js");
    specs.add("tests/browser/scripttagger-global-injection.spec.js");
    continue;
  }
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
const referenceGateRequired = full || selected.some(path => referenceRequiredSpecs.has(path));
const groupAChangedBrowserSpecs = changedBrowserSpecs.filter(path =>
  !studySessionSpecs.has(path) &&
  !(referenceGateRequired && (full || selected.includes(path)) && referenceDelegatedSpecs.has(path))
);


const values = {
  full_browser_suite: String(full),
  changed_specs: selected.join(","),
  changed_browser_specs: changedBrowserSpecs.join(","),
  group_a_changed_browser_specs: groupAChangedBrowserSpecs.join(","),
  unmapped_specs: unmapped.join(","),
  extension_spec_required: String(full || selected.includes("tests/browser/extension.spec.js")),
  group_a_required: String(full || [...groupARequiredSpecs].some(path => selected.includes(path)) || unmapped.length > 0 || (!focusedSourcePageRuntimeChange && groupAChangedBrowserSpecs.length > 0)),
  study_sessions_required: String(full || [...selected, ...changedBrowserSpecs].some(path => studySessionSpecs.has(path))),
  group_b_required: String(full || [...groupBRequiredSpecs].some(path => selected.includes(path))),
  reference_required: String(referenceGateRequired)
};
const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(""));
for (const [key,value] of Object.entries(values)) console.log(`${key}=${value}`);
console.log(`changed_files=${changed.length}`);
if (selected.length) console.log("selected_specs:\n- " + selected.join("\n- "));
if (missingMappedSpecs.length) console.log("missing_mapped_specs:\n- " + missingMappedSpecs.join("\n- "));
