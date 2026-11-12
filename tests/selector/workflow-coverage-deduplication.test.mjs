import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mappedSpecs, separatelyManagedSpecs, referenceDelegatedSpecs,
  groupARequiredSpecs, groupBRequiredSpecs,
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

  assert.deepEqual([...referenceDelegatedSpecs].sort(), [...matrixOwned].sort(),
    "the registry's delegated-spec inventory must exactly match the reference matrix ownership");
  for (const spec of matrixOwned) {
    assert.ok(mappedSpecs.has(spec), "matrix-owned spec must not enter the Group A unmapped fallback: " + spec);
  }

  for (const spec of groupARequiredSpecs) {
    assert.ok(mappedSpecs.has(spec), "Group A gate ownership must be a classified spec: " + spec);
  }
  for (const spec of groupBRequiredSpecs) {
    assert.ok(groupsWorkflow.includes(spec), "Group B ownership must have a workflow invocation: " + spec);
  }
  for (const spec of studySessionSpecs) {
    assert.ok(groupsWorkflow.includes(spec), "Study Sessions ownership must have a workflow invocation: " + spec);
  }

  assert.ok(groupsWorkflow.includes("inputs.group_a_changed_browser_specs"));
  const changedSpecRunner = groupsWorkflow.match(
    /- name: Run every non-delegated changed browser spec([\\s\\S]*?)(?=\\n      - name:)/
  );
  assert.ok(changedSpecRunner, "filtered changed-spec runner must exist");
  assert.match(changedSpecRunner[1], /npx playwright test "\\$\\{specs\\[@\\]\\}" --max-failures=1/);
  assert.equal((changedSpecRunner[1].match(/npx playwright test/g) || []).length, 1,
    "changed browser specs should share one Playwright process");
  assert.ok(referenceWorkflow.includes("group_a_changed_browser_specs: ${{ steps.browser-select.outputs.group_a_changed_browser_specs }}"));
  assert.ok(referenceWorkflow.includes("group_a_changed_browser_specs: ${{ needs.change-detection.outputs.group_a_changed_browser_specs }}"));
  assert.doesNotMatch(groupsWorkflow, /case "\$spec" in/, "workflow must not maintain a second delegated-spec inventory");
});

test("gate ownership sets are subsets of the authoritative mapped browser-spec inventory", () => {
  const classifications = [
    groupARequiredSpecs, groupBRequiredSpecs,
    referenceRequiredSpecs, referenceDelegatedSpecs, studySessionSpecs
  ];
  for (const classification of classifications) {
    for (const spec of classification) {
      assert.ok(mappedSpecs.has(spec) || separatelyManagedSpecs.has(spec),
        "gate-owned spec must be classified for focused CI: " + spec);
    }
  }
});

test("Group A changed-spec execution uses selector-filtered ownership rather than workflow-local lists", () => {
  assert.ok(groupsWorkflow.includes("inputs.group_a_changed_browser_specs"));
  assert.ok(groupsWorkflow.includes("GROUP_A_CHANGED_BROWSER_SPECS"));
  assert.doesNotMatch(groupsWorkflow, /case "\$spec" in/);
  for (const spec of referenceDelegatedSpecs) {
    assert.ok(mappedSpecs.has(spec), "delegated spec must remain classified: " + spec);
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
