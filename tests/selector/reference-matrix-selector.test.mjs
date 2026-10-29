import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseReferenceMatrix, selectReferenceMatrix } from "../../scripts/select-reference-matrix.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/browser-e2e-reference.yml", import.meta.url), "utf8");
const entries = parseReferenceMatrix(workflow);

test("parses the workflow matrix without losing group/file/grep values", () => {
  assert.ok(entries.length >= 20, `expected the full reference matrix, found ${entries.length}`);
  assert.equal(new Set(entries.map(entry => entry.group)).size, entries.length);
  assert.ok(entries.some(entry => entry.group === "redirect-hostnames" && entry.file === "tests/browser/redirect-hostnames.spec.js"));
  assert.ok(entries.some(entry => entry.group === "grammar-token-coverage-ot" && entry.grep.includes("exhaustive token coverage")));
});

test("full-suite fallback selects every declared matrix entry", () => {
  assert.deepEqual(selectReferenceMatrix(entries, { full: true }), entries);
});

test("mapped redirect change selects only matrix groups for its selected spec", () => {
  const selected = selectReferenceMatrix(entries, { changedSpecs: "tests/browser/redirect-hostnames.spec.js" });
  assert.deepEqual(selected.map(entry => entry.group), ["redirect-hostnames"]);
});

test("unknown or shared-core full-suite selection retains broad matrix coverage", () => {
  const selected = selectReferenceMatrix(entries, { full: true, changedSpecs: "tests/browser/redirect-hostnames.spec.js" });
  assert.equal(selected.length, entries.length);
});

test("test spec edited alongside runtime preserves the existing generic-spec exclusion", () => {
  const selected = selectReferenceMatrix(entries, {
    changedSpecs: "tests/browser/extension.spec.js,tests/browser/redirect-hostnames.spec.js",
    changedBrowserSpecs: "tests/browser/extension.spec.js"
  });
  assert.ok(!selected.some(entry => !entry.file), "generic extension.spec matrix groups should remain excluded");
  assert.ok(selected.some(entry => entry.group === "redirect-hostnames"));
});

test("unselected matrix entries are omitted before runner allocation", () => {
  assert.deepEqual(selectReferenceMatrix(entries, { changedSpecs: "tests/browser/redirect-hostnames.spec.js" }).map(x => x.group), ["redirect-hostnames"]);
  assert.deepEqual(selectReferenceMatrix(entries, { changedSpecs: "" }), []);
});
