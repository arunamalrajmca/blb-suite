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
// Main pushes should select coverage from the pushed diff, just like PRs. Keep a full run for manual dispatches and first pushes where GitHub provides an all-zero before SHA.
const alwaysFull = event === "workflow_dispatch" || (event === "push" && ref === "refs/heads/main" && (!base || /^0+$/.test(base)));
const knownFailuresOnly = process.env.KNOWN_FAILURES_ONLY === "true";
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

const browserSpecPattern = /^tests\/browser\/[^/]+\.spec\.js$/;
const existingBrowserSpecs = new Set(run(["ls-tree", "-r", "--name-only", "HEAD", "--", "tests/browser"]).split("\n").filter(Boolean));
// Test-file edits alone must not launch feature E2E suites. Those suites are
// selected by production-file changes below; this prevents a double-click test
// edit, for example, from triggering double-click E2E when production is untouched.
// An explicit workflow_dispatch or main push remains a full verification run.
const changedBrowserSpecs = [];
const specs = new Set();
// Shared-core, test-infrastructure, package, manifest, and unknown production
// changes remain conservative and may require the full applicable browser suite.
// Shared background changes remain broad by default. Narrow only the exact, isolated
// omnibox runtime + regression-spec pair so an unrelated core E2E failure cannot
// block that independently covered fix. Background-only or mixed changes stay full.
const focusedOmniboxBackgroundChange = changed.length === 2
  && changed.includes("extension/background.js")
  && changed.includes("tests/browser/omnibox-command-routing.spec.js");
const forceFull = alwaysFull || changed.some(path =>
  (path.startsWith("scripts/") && !/^scripts\/(?:classify-ci-changes|select-browser-specs|select-reference-matrix)\.mjs$/.test(path) && path !== "scripts/test-ci-routing-selector.js" && path !== "scripts/reference-e2e-matrix.json")
  || path.startsWith("regression-suite/")
  || (path.startsWith("tests/") && !/^tests\/selector\//.test(path) && !/^tests\/browser\/[^/]+\.spec\.js$/.test(path))
  || path === "package.json"
  || path === "package-lock.json"
  || path === "playwright.config.js"
  || path === "playwright.config.ts"
  || path === "extension/manifest.json"
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
);

// Explicit, conservative file-to-feature map. Mapped files only narrow browser
// coverage when the implementation is genuinely feature-scoped.
const featureSpecs = [
  {
    // The shared content script's contextual-token fixes are covered by the
    // known failure inventory in extension.spec.js. Keep this isolated change
    // focused; mixed/shared changes still use the conservative full-suite path.
    paths: ["extension/content.js"],
    specs: ["tests/browser/extension.spec.js"]
  },
  {
    paths: ["extension/background.js"],
    specs: [
      "tests/browser/popup-master-toggle-regression.spec.js",
      "tests/browser/facebook-selection-parser.spec.js",
      "tests/browser/substack-selection-parser.spec.js",
      "tests/browser/omnibox-command-routing.spec.js",
      "tests/browser/pdf-selection-regressions.spec.js"
    ]
  },
  {
    paths: ["extension/kjv-case-sensitive-words.js"],
    specs: ["tests/browser/case-sensitive-routing-behavior.spec.js"]
  },
  {
    paths: ["extension/omnibox-search-helpers.js"],
    specs: ["tests/browser/omnibox-boolean-operators.spec.js"]
  },
  {
    paths: ["extension/selection-text-helpers.js"],
    specs: ["tests/browser/extension.spec.js", "tests/browser/e2e-core-user-actions.spec.js"]
  },
  {
    paths: ["extension/study-session-export.js"],
    specs: ["tests/browser/study-session-export.spec.js"]
  },
  {
    paths: ["extension/study-session-normalization.js"],
    specs: ["tests/browser/study-session-popup-ui-regression.spec.js", "tests/browser/study-backup-restore.spec.js", "tests/browser/feature-lifecycle-regressions.spec.js"]
  },
  {
    paths: ["extension/multiverse-reference-helpers.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js", "tests/browser/multiverse-tab-reuse.spec.js"]
  },
  {
    paths: ["extension/redirect-bibleref-ranges.js", "extension/redirect-christianity-main-world.js"],
    specs: ["tests/browser/redirect-source-url-patterns.spec.js", "tests/browser/redirect-source-url-browser.spec.js", "tests/browser/redirect-hostnames.spec.js", "tests/browser/blb-non-kjv-redirect.spec.js"]
  },
  {
    paths: ["extension/source-bible-redirect.js"],
    specs: ["tests/browser/redirect-source-url-browser.spec.js", "tests/browser/redirect-source-url-patterns.spec.js", "tests/browser/redirect-hostnames.spec.js"]
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
    specs: ["tests/browser/site-feature-defaults.spec.js", "tests/browser/study-session-popup-ui-regression.spec.js", "tests/browser/study-backup-restore.spec.js", "tests/browser/feature-lifecycle-regressions.spec.js", "tests/browser/redirect-toggle-isolation.spec.js", "tests/browser/popup-master-toggle-regression.spec.js"]
  },
  {
    paths: ["extension/kings-bible-collector.js"],
    specs: ["tests/browser/kings-bible-collector-behavior.spec.js"]
  },
  {
    paths: ["extension/webster-collector.js"],
    specs: ["tests/browser/webster-collector-behavior.spec.js"]
  },
  {
    paths: ["extension/source-page-collector.js"],
    specs: ["tests/browser/source-page-collector-behavior.spec.js"]
  },
  {
    paths: ["extension/multiverse-copy.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js"]
  },
  {
    paths: ["extension/multiverse-tool-view.js"],
    specs: ["tests/browser/multiverse-tool-view.spec.js"]
  },
  {
    paths: ["extension/study-reference-capture.js"],
    specs: ["tests/browser/study-reference-capture.spec.js"]
  },
  {
    paths: ["extension/criteria-search-navigation.js"],
    specs: ["tests/browser/criteria-search-navigation.spec.js"]
  },
  {
    paths: ["extension/blb-auto-hyperlinker.js"],
    specs: ["tests/browser/blb-auto-hyperlinker.spec.js"]
  },
  {
    paths: ["extension/blb-passive-new-tab-targets.js"],
    specs: ["tests/browser/blb-passive-new-tab-targets.spec.js"]
  },
  {
    paths: ["extension/blb-draggable-button.js"],
    specs: ["tests/browser/blb-draggable-button.spec.js"]
  },
  {
    paths: ["extension/blb-parse-popup.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js"]
  },
  {
    paths: ["extension/blb-verse-link-navigation.js"],
    specs: ["tests/browser/blb-verse-link-navigation.spec.js"]
  },
  {
    paths: ["extension/blb-page-selection-button.js"],
    specs: ["tests/browser/e2e-core-user-actions.spec.js", "tests/browser/feature-lifecycle-regressions.spec.js", "tests/browser/site-feature-defaults.spec.js"]
  },
  {
    paths: ["extension/multiverse-handoff.js"],
    specs: ["tests/browser/multiverse-handoff.spec.js"]
  },
  {
    paths: ["extension/Tutorial.html", "extension/Tutorial.js"],
    specs: []
  }
];
const ignoredNonRuntime = path =>
  /^(?:docs\/|README(?:\.|$)|LICENSE(?:\.|$)|CHANGELOG(?:\.|$)|CONTRIBUTING(?:\.|$)|\.github\/(?:workflows\/|ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\/))/.test(path)
  || /^(?:store-assets\/|assets\/store\/|extension\/(?:icons|store-assets)\/)/.test(path)
  || /^extension\/(?:Tutorial\.html|Tutorial\.js|THIRD-PARTY-NOTICES\.txt)$/.test(path)
  || /^scripts\/(?:classify-ci-changes|select-browser-specs|select-reference-matrix)\.mjs$/.test(path)
  || path === "scripts/test-ci-routing-selector.js"
  || path === "scripts/reference-e2e-matrix.json"
  || /^tests\/selector\//.test(path);

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
const full = !knownFailuresOnly && (forceFull || unknownRuntime || missingMappedSpecs.length > 0);
const selected = knownFailuresOnly ? ["tests/browser/extension.spec.js"] : [...specs].filter(path => existingBrowserSpecs.has(path)).sort();
const mappedSpecs = new Set([
  "tests/browser/redirect-source-url-patterns.spec.js",
  "tests/browser/omnibox-boolean-operators.spec.js",
  "tests/browser/redirect-source-url-browser.spec.js",
  "tests/browser/e2e-core-user-actions.spec.js",
  "tests/browser/kings-bible-collector-behavior.spec.js",
  "tests/browser/feature-lifecycle-regressions.spec.js",
  "tests/browser/study-backup-restore.spec.js",
  "tests/browser/study-reference-capture.spec.js",
  "tests/browser/study-session-export.spec.js",
  "tests/browser/extension.spec.js",
  "tests/browser/redirect-hostnames.spec.js",
  "tests/browser/blb-non-kjv-redirect.spec.js",
  "tests/browser/scripttagger-global-injection.spec.js",
  "tests/browser/shared-regex-patterns.spec.js",
  "tests/browser/rediscover-sagacity-button.spec.js",
  "tests/browser/research-dom-smoke.spec.js",
  "tests/browser/multiverse-tab-reuse.spec.js",
  "tests/browser/multiverse-tool-view.spec.js",
  "tests/browser/multiverse-handoff.spec.js",
  "tests/browser/blb-passive-new-tab-targets.spec.js",
  "tests/browser/source-page-collector-behavior.spec.js",
  "tests/browser/blb-verse-link-navigation.spec.js",
  "tests/browser/criteria-search-navigation.spec.js",
  "tests/browser/performance.spec.js",
  "tests/browser/site-feature-defaults.spec.js",
  "tests/browser/study-session-popup-ui-regression.spec.js",
  "tests/browser/webster-collector-behavior.spec.js",
  "tests/browser/blb-auto-hyperlinker.spec.js",
  "tests/browser/blb-draggable-button.spec.js",
  "tests/browser/case-sensitive-routing-behavior.spec.js",
  "tests/browser/redirect-toggle-isolation.spec.js",
  "tests/browser/multiverse-clipboard-reference-pattern.spec.js",
  "tests/browser/popup-master-toggle-regression.spec.js",
  "tests/browser/facebook-selection-parser.spec.js",
  "tests/browser/substack-selection-parser.spec.js",
  "tests/browser/omnibox-command-routing.spec.js",
  "tests/browser/pdf-selection-regressions.spec.js"
]);
const separatelyManagedSpecs = new Set(["tests/browser/multiverse-tab-reuse.spec.js", "tests/browser/performance.spec.js"]);
const unmapped = selected.filter(path => !mappedSpecs.has(path) && !separatelyManagedSpecs.has(path));
const has = (...names) => full || selected.some(path => names.includes(path));
const values = {
  full_browser_suite: String(full),
  changed_specs: selected.join(","),
  changed_browser_specs: knownFailuresOnly ? "" : changedBrowserSpecs.join(","),
  unmapped_specs: unmapped.join(","),
  extension_spec_required: String(!knownFailuresOnly && (full || selected.includes("tests/browser/extension.spec.js"))),
  group_a_required: String(!knownFailuresOnly && (has(
    "tests/browser/redirect-source-url-patterns.spec.js",
    "tests/browser/omnibox-boolean-operators.spec.js",
    "tests/browser/redirect-source-url-browser.spec.js",
    "tests/browser/e2e-core-user-actions.spec.js",
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
    "tests/browser/feature-lifecycle-regressions.spec.js",
    "tests/browser/study-backup-restore.spec.js",
    "tests/browser/study-reference-capture.spec.js",
    "tests/browser/study-session-export.spec.js",
    "tests/browser/extension.spec.js",
    "tests/browser/site-feature-defaults.spec.js",
    "tests/browser/study-session-popup-ui-regression.spec.js"
   ) || unmapped.length > 0 || changedBrowserSpecs.length > 0)),
  group_b_required: String(!knownFailuresOnly && has(
    "tests/browser/redirect-hostnames.spec.js",
    "tests/browser/blb-non-kjv-redirect.spec.js",
    "tests/browser/scripttagger-global-injection.spec.js"
  )),
  reference_required: String(has(
    "tests/browser/extension.spec.js",
    "tests/browser/shared-regex-patterns.spec.js",
    "tests/browser/rediscover-sagacity-button.spec.js",
    "tests/browser/research-dom-smoke.spec.js",
    "tests/browser/redirect-source-url-patterns.spec.js",
    "tests/browser/redirect-source-url-browser.spec.js",
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
