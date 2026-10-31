import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateReferenceMatrix, selectReferenceMatrix } from "../../scripts/select-reference-matrix.mjs";

const entries = validateReferenceMatrix(JSON.parse(readFileSync(new URL("../../scripts/reference-e2e-matrix.json", import.meta.url), "utf8")));

test("reference matrix defines unique, complete entries", () => {
  assert.ok(entries.length >= 5, `expected the full reference matrix, found ${entries.length}`);
  assert.equal(new Set(entries.map(entry => entry.group)).size, entries.length);
  assert.ok(entries.some(entry => entry.group === "redirect-source-smoke-batch" && entry.files.includes("tests/browser/redirect-hostnames.spec.js")));
  assert.ok(entries.some(entry => entry.group === "specialized-reference-smoke-batch" && entry.files.length === 3));
  const extensionCoverage = entries.find(entry => entry.group === "extension-spec-reference-coverage");
  assert.equal(extensionCoverage.grep, "Acts 7, v.25",
    "only the still-unverified four-action verse-cue matrix should run");
});

test("full-suite fallback selects every declared matrix entry", () => {
  assert.deepEqual(selectReferenceMatrix(entries, { full: true }), entries);
});

test("mapped redirect change selects only matrix groups for its selected spec", () => {
  const selected = selectReferenceMatrix(entries, { changedSpecs: "tests/browser/redirect-hostnames.spec.js" });
  assert.deepEqual(selected.map(entry => entry.group), ["redirect-source-smoke-batch"]);
});

test("shared-core or unknown runtime full-suite selection retains broad matrix coverage", () => {
  const selected = selectReferenceMatrix(entries, { full: true, changedSpecs: "tests/browser/redirect-hostnames.spec.js" });
  assert.equal(selected.length, entries.length);
});

test("test spec edited alongside runtime preserves the existing generic-spec exclusion", () => {
  const selected = selectReferenceMatrix(entries, {
    changedSpecs: "tests/browser/extension.spec.js,tests/browser/redirect-hostnames.spec.js",
    changedBrowserSpecs: "tests/browser/extension.spec.js"
  });
  assert.ok(!selected.some(entry => !entry.file && !entry.files), "generic extension.spec matrix groups should remain excluded");
  assert.ok(selected.some(entry => entry.group === "redirect-source-smoke-batch"));
});

test("unselected matrix entries are omitted before runner allocation", () => {
  assert.deepEqual(selectReferenceMatrix(entries, { changedSpecs: "tests/browser/redirect-hostnames.spec.js" }).map(x => x.group), ["redirect-source-smoke-batch"]);
  assert.deepEqual(selectReferenceMatrix(entries, { changedSpecs: "" }), []);
});
