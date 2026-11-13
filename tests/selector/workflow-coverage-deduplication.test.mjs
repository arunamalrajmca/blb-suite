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
  const end = groupsWorkflow.indexOf(String.fromCharCode(10) + "      - name:", start);
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
  const core = groupsWorkflow.match(/  core-user-actions:
([sS]*?)(?=
  toggle-permission-lifecycle:)/);
  assert.ok(core, "core user-action job exists");
  assert.ok(core[1].includes("tests/browser/e2e-core-user-actions.spec.js"));
  const toggle = groupsWorkflow.match(/  toggle-permission-lifecycle:
([sS]*?)(?=
  core-group-a:)/);
  assert.ok(toggle, "parallel toggle/permission job exists");
  const expected = [
    "tests/browser/popup-site-toggle-independence.spec.js",
    "tests/browser/popup-master-toggle-regression.spec.js",
    "tests/browser/redirect-toggle-isolation.spec.js",
    "tests/browser/optional-host-permission-lifecycle.spec.js"
  ];
  for (const spec of expected) assert.ok(toggle[1].includes(spec), "retains " + spec);
  assert.ok(toggle[1].includes('npx playwright test "${{ matrix.spec }}" --max-failures=1'));
  assert.match(toggle[1], /fail-fast:s*false/);
  assert.doesNotMatch(groupsWorkflow, /Run remaining toggle isolation and permission lifecycle regressions/);
  const summary = groupsWorkflow.slice(groupsWorkflow.indexOf("  feature-groups-summary:"));
  assert.ok(summary.includes("needs.core-user-actions.result"));
  assert.ok(summary.includes("needs.toggle-permission-lifecycle.result"));
  assert.ok(summary.includes('check_group "Core user actions"'));
  assert.ok(summary.includes('check_group "Toggle and permission lifecycle"'));
});

test("reference feature coverage is parallel and does not wait for the reference matrix", () => {
  const feature = referenceWorkflow.match(/  browser-e2e-features:
([sS]*?)(?=
  grouped-browser-e2e:)/);
  assert.ok(feature, "feature coverage job exists");
  const block = feature[1];
  const needs = block.match(/    needs:
([sS]*?)(?=
    if:)/);
  assert.ok(needs && needs[1].includes("change-detection"));
  assert.doesNotMatch(needs[1], /browser-e2e/);
  assert.match(block, /fail-fast:s*false/);
  for (const spec of ["tests/browser/extension-reference-actions.spec.js","tests/browser/extension-lifecycle.spec.js"]) {
    assert.ok(block.includes(spec), "parallel feature matrix retains " + spec);
  }
  assert.ok(block.includes('npx playwright test "${{ matrix.spec }}" --grep'));
  assert.ok(block.includes("strategy.job-index"), "parallel matrix artifacts must have unique names");
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
