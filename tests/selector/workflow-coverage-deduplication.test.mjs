import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const matrix = JSON.parse(readFileSync(
  new URL("../../scripts/reference-e2e-matrix.json", import.meta.url),
  "utf8"
));
const groupsWorkflow = readFileSync(
  new URL("../../.github/workflows/browser-e2e-groups.yml", import.meta.url),
  "utf8"
);

test("matrix-owned changed browser specs are delegated instead of run a second time in Group A", () => {
  const caseBlock = groupsWorkflow.match(
    /tests\/browser\/redirect-source-url-patterns\.spec\.js\|([\s\S]*?)\)\n\s+if \(\[\[ "\$REFERENCE_GATE_REQUIRED"/
  );
  assert.ok(caseBlock, "Group A must retain an explicit reference-matrix delegation case");

  const delegated = new Set([
    "tests/browser/redirect-source-url-patterns.spec.js",
    ...[...caseBlock[1].matchAll(/tests\/browser\/[\w-]+\.spec\.js/g)].map(match => match[0])
  ]);
  const matrixOwned = new Set(matrix.flatMap(entry =>
    entry.files || (entry.file ? [entry.file] : [])
  ));
  matrixOwned.delete("tests/browser/extension.spec.js");

  for (const spec of matrixOwned) {
    assert.ok(delegated.has(spec), "matrix-owned spec must be delegated: " + spec);
  }
});

test("dedicated Group A runs defer to the changed-spec runner when that file changed", () => {
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
