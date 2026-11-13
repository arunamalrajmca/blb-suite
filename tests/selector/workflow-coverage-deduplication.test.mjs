import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mappedSpecs, separatelyManagedSpecs, referenceDelegatedSpecs,
  groupARequiredSpecs, groupBRequiredSpecs,
  referenceRequiredSpecs, studySessionSpecs
} from "../../scripts/ci-routing-registry.mjs";

const matrix = JSON.parse(readFileSync(
  new URL("../../scripts/reference-e2e-matrix.json", import.meta.url), "utf8"
));
const groupsWorkflow = readFileSync(
  new URL("../../.github/workflows/browser-e2e-groups.yml", import.meta.url), "utf8"
);
const referenceWorkflow = readFileSync(
  new URL("../../.github/workflows/browser-e2e-reference.yml", import.meta.url), "utf8"
);

test("matrix-owned changed browser specs are delegated by the central registry", () => {
  const matrixOwned = new Set(matrix.flatMap(entry => entry.files || (entry.file ? [entry.file] : [])));
  matrixOwned.delete("tests/browser/extension-reference-actions.spec.js");
  assert.deepEqual([...referenceDelegatedSpecs].sort(), [...matrixOwned].sort());
  for (const spec of matrixOwned) assert.ok(mappedSpecs.has(spec), "matrix spec remains classified: " + spec);
  for (const spec of groupARequiredSpecs) assert.ok(mappedSpecs.has(spec));
  for (const spec of groupBRequiredSpecs) assert.ok(groupsWorkflow.includes(spec));
  for (const spec of studySessionSpecs) assert.ok(groupsWorkflow.includes(spec));
  assert.ok(groupsWorkflow.includes("inputs.group_a_changed_browser_specs"));
  const start = groupsWorkflow.indexOf("- name: Run every non-delegated changed browser spec");
  const end = groupsWorkflow.indexOf("\n      - name:", start);
  assert.ok(start >= 0 && end > start);
  const changedRunner = groupsWorkflow.slice(start, end);
  assert.ok(changedRunner.includes('npx playwright test "${specs[@]}" --max-failures=1'));
  assert.equal(changedRunner.split("npx playwright test").length - 1, 1);
  assert.ok(referenceWorkflow.includes("group_a_changed_browser_specs: ${{ steps.browser-select.outputs.group_a_changed_browser_specs }}"));
  assert.ok(referenceWorkflow.includes("group_a_changed_browser_specs: ${{ needs.change-detection.outputs.group_a_changed_browser_specs }}"));
  assert.doesNotMatch(groupsWorkflow, /case "$spec" in/);
});

test("gate ownership sets remain subsets of the authoritative mapped inventory", () => {
  for (const set of [groupARequiredSpecs, groupBRequiredSpecs, referenceRequiredSpecs, referenceDelegatedSpecs, studySessionSpecs]) {
    for (const spec of set) assert.ok(mappedSpecs.has(spec) || separatelyManagedSpecs.has(spec), "classified: " + spec);
  }
});

test("Group A core user actions and toggle/permission suites run in independent jobs", () => {
  const coreStart = groupsWorkflow.indexOf("  core-user-actions:\n");
  const toggleStart = groupsWorkflow.indexOf("  toggle-permission-lifecycle:\n");
  const groupAStart = groupsWorkflow.indexOf("  core-group-a:\n");
  assert.ok(coreStart >= 0 && toggleStart > coreStart && groupAStart > toggleStart);
  const core = groupsWorkflow.slice(coreStart, toggleStart);
  const toggle = groupsWorkflow.slice(toggleStart, groupAStart);
  assert.ok(core.includes("tests/browser/e2e-core-user-actions.spec.js"));
  const expected = [
    "tests/browser/popup-site-toggle-independence.spec.js",
    "tests/browser/popup-master-toggle-regression.spec.js",
    "tests/browser/redirect-toggle-isolation.spec.js",
    "tests/browser/optional-host-permission-lifecycle.spec.js"
  ];
  for (const spec of expected) assert.ok(toggle.includes(spec), "retains " + spec);
  assert.ok(toggle.includes('npx playwright test "${{ matrix.spec }}" --max-failures=1'));
  assert.ok(toggle.includes("fail-fast: false"));
  assert.doesNotMatch(groupsWorkflow, /Run remaining toggle isolation and permission lifecycle regressions/);
  const summary = groupsWorkflow.slice(groupsWorkflow.indexOf("  feature-groups-summary:"));
  assert.ok(summary.includes("needs.core-user-actions.result"));
  assert.ok(summary.includes("needs.toggle-permission-lifecycle.result"));
  assert.ok(summary.includes('check_group "Core user actions"'));
  assert.ok(summary.includes('check_group "Toggle and permission lifecycle"'));
});

test("core user-action coverage is split into disjoint parallel groups without losing tests", () => {
  const start = groupsWorkflow.indexOf("  core-user-actions:" + String.fromCharCode(10));
  const end = groupsWorkflow.indexOf(String.fromCharCode(10) + "  toggle-permission-lifecycle:", start);
  assert.ok(start >= 0 && end > start);
  const job = groupsWorkflow.slice(start, end);
  assert.ok(job.includes("fail-fast: false"));
  assert.ok(job.includes('npx playwright test tests/browser/e2e-core-user-actions.spec.js --grep "${{ matrix.grep }}"'));
  const source = readFileSync(new URL("../browser/e2e-core-user-actions.spec.js", import.meta.url), "utf8");
  const titles = [...source.matchAll(/test[(]'([^']+)'/g)].map(match => match[1]);
  const groups = [
    /physical right-click preserves|failed context-menu action leaves Alt[+]B available|Alt[+]B command path opens|MultiVerse Copy button adds|normal Ctrl[+]C in MultiVerse|copying typed MultiVerse references|BLB verse links inside parse popups|single-token selection actions share positional resolution/,
    /continuous same-chapter multi-reference selection|selection containing a reference and authored prose|chapter-only ranges expand|MultiVerse batches disjoint chapter ranges|MultiVerse parses reversed disjoint chapter ranges/,
    /Double-Click resolves contextual chapter numbers|Double-Click preserves Facebook bidi-isolated Matthew|Double-Click numbered-list labels|Double-Click on serials above 66|Ordinary numbers without a list-label period|Double-Click anywhere in a consecutive comma-separated verse citation|Double-Click resolves references through custom and framework-generated DOM containers|Double-Click resolves partial references in Instagram-style rich text/,
    /Facebook resolves repeated references|Facebook Luke 22:26 resolves only within its own dir-auto line|Show on BLB searches the complete numbered book|Facebook book-name double-click retains Luke|Facebook book clicks use only permitted immediate context|Double-Click on Vs[.] resolves/
  ];
  assert.ok(titles.length >= 25, "core user-action suite inventory is substantial and must not silently shrink");
  for (const title of titles) {
    assert.equal(groups.filter(group => group.test(title)).length, 1, "core user-action test selected exactly once: " + title);
  }
});

test("reference feature coverage is parallel and does not wait for the reference matrix", () => {
  const start = referenceWorkflow.indexOf("  browser-e2e-features:\n");
  const end = referenceWorkflow.indexOf("\n  grouped-browser-e2e:", start);
  assert.ok(start >= 0 && end > start);
  const feature = referenceWorkflow.slice(start, end);
  const needsStart = feature.indexOf("    needs:\n");
  const needsEnd = feature.indexOf("\n    if:", needsStart);
  const needs = feature.slice(needsStart, needsEnd);
  assert.ok(needs.includes("change-detection"));
  assert.ok(!needs.includes("browser-e2e"));
  assert.ok(feature.includes("fail-fast: false"));
  for (const spec of ["tests/browser/extension-reference-actions.spec.js", "tests/browser/extension-lifecycle.spec.js"]) {
    assert.ok(feature.includes(spec), "parallel feature matrix retains " + spec);
  }
  assert.ok(feature.includes('npx playwright test "${{ matrix.spec }}" --grep'));
  assert.ok(feature.includes("strategy.job-index"), "parallel matrix artifacts must have unique names");
});

test("split reference matrix groups preserve the former test-title coverage exactly once", () => {
  const groups = matrix.filter(entry => entry.group.startsWith("extension-spec-reference"));
  assert.equal(groups.length, 5);
  const source = readFileSync(new URL("../browser/extension-reference-actions.spec.js", import.meta.url), "utf8");
  const titles = [...source.matchAll(/test[(]'([^']+)'/g)].map(match => match[1]);
  const previous = /(?:Double-click resolves any part|positional context|browser token|separate lines|standalone book numbers|ordinary heading words)|(?:generic reference grammar — exhaustive token coverage — OT)|(?:generic reference grammar — exhaustive token coverage — NT)|(?:generic reference syntax — colon forms)|(?:generic reference syntax — dot forms)|(?:generic reference syntax — spaced forms)|(?:generic reference syntax — chapter forms)|(?:generic reference syntax — range forms)|(?:generic aliases|numbered aliases and Roman prefixes|standalone Roman prefixes)|(?:All 66 canonical)|(?:Same-chapter ranges — all 66 books through)|(?:Same-chapter range resolution covers all 66 books on Double-Click)/;
  const priorTitles = titles.filter(title => previous.test(title));
  assert.ok(priorTitles.length >= 15);
  for (const title of priorTitles) {
    assert.equal(groups.filter(entry => new RegExp(entry.grep).test(title)).length, 1, "exactly once: " + title);
  }
});
