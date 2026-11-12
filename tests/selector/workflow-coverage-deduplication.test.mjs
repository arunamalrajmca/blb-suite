import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mappedSpecs, separatelyManagedSpecs, referenceDelegatedSpecs,
  groupARequiredSpecs, groupAExecutionSpecs, groupBRequiredSpecs,
  referenceRequiredSpecs, studySessionSpecs
} from "../../scripts/ci-routing-registry.mjs";

const matrix = JSON.parse(readFileSync(
  new URL("../../scripts/reference-e2e-matrix.json", import.meta.url),
  "utf8"
));
const groupsWorkflow = readFileSync(
  new URL("../../.github/workflows/browser-e2e-groups.yml", import.meta.url),
  "utf8"
);
const referenceWorkflow = readFileSync(
  new URL("../../.github/workflows/browser-e2e-reference.yml", import.meta.url),
  "utf8"
);

test("matrix-owned changed browser specs are delegated by the central registry", () => {
  const matrixOwned = new Set(matrix.flatMap(entry =>
    entry.files || (entry.file ? [entry.file] : [])
  ));
  matrixOwned.delete("tests/browser/extension.spec.js");

  for (const spec of matrixOwned) {
    assert.ok(mappedSpecs.has(spec), "matrix-owned spec must not enter the Group A unmapped fallback: " + spec);
    assert.ok(referenceDelegatedSpecs.has(spec), "matrix-owned spec must be delegated: " + spec);
  }

  assert.ok(groupsWorkflow.includes("inputs.group_a_changed_browser_specs"));
  assert.ok(referenceWorkflow.includes("group_a_changed_browser_specs: ${{ steps.browser-select.outputs.group_a_changed_browser_specs }}"));
  assert.ok(referenceWorkflow.includes("group_a_changed_browser_specs: ${{ needs.change-detection.outputs.group_a_changed_browser_specs }}"));
  assert.doesNotMatch(groupsWorkflow, /case "\$spec" in/, "workflow must not maintain a second delegated-spec inventory");
});

test("gate ownership sets are subsets of the authoritative mapped browser-spec inventory", () => {
  const classifications = [
    groupARequiredSpecs, groupAExecutionSpecs, groupBRequiredSpecs,
    referenceRequiredSpecs, referenceDelegatedSpecs, studySessionSpecs
  ];
  for (const classification of classifications) {
    for (const spec of classification) {
      assert.ok(mappedSpecs.has(spec) || separatelyManagedSpecs.has(spec),
        "gate-owned spec must be classified for focused CI: " + spec);
    }
  }
});

test("Group A execution ownership excludes specs delegated to References or Study Sessions", () => {
  for (const spec of groupAExecutionSpecs) {
    assert.ok(groupARequiredSpecs.has(spec), "Group A execution spec must remain in its original ownership set: " + spec);
    assert.ok(!referenceDelegatedSpecs.has(spec), "Reference-delegated spec must not require Group A execution: " + spec);
    assert.ok(!studySessionSpecs.has(spec), "Study Sessions spec must not require Group A execution: " + spec);
  }
  for (const spec of referenceDelegatedSpecs) {
    assert.ok(!groupAExecutionSpecs.has(spec), "Reference-delegated spec must not allocate Group A: " + spec);
  }
});

test("dedicated Group A steps defer to the changed-spec runner when that file changed", () => {
  const auditStep = groupsWorkflow.match(
    /- name: Run confirmed audit defect regressions\n\s+if: ([^\n]+)/
  );
  assert.ok(auditStep, "audit-defect regression step must exist");
  assert.ok(auditStep[1].includes("!contains(inputs.changed_browser_specs, 'tests/browser/audit-defect-regressions.spec.js')"),
    "audit-defect step must not rerun a changed spec");

  const extensionStep = groupsWorkflow.match(
    /- name: Run extension source-page and reference-context regressions\n\s+if: ([^\n]+)/
  );
  assert.ok(extensionStep, "extension source/reference regression step must exist");
  assert.ok(extensionStep[1].includes("!contains(inputs.changed_browser_specs, 'tests/browser/extension.spec.js')"),
    "subset grep must not rerun tests already executed from a changed extension.spec.js");
});
