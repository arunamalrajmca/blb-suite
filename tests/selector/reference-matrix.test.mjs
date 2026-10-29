import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const matrix = JSON.parse(readFileSync(
  new URL("../../scripts/reference-e2e-matrix.json", import.meta.url),
  "utf8"
));

test("extension.spec.js reference checks share one matrix runner without dropping grep coverage", () => {
  const grouped = matrix.filter(entry => entry.group === "extension-spec-reference-coverage");
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].file, undefined, "group must continue to target the default extension.spec.js");
  assert.doesNotThrow(() => new RegExp(grouped[0].grep));

  for (const pattern of [
    "Double-click resolves any part",
    "generic reference grammar — exhaustive token coverage — OT",
    "generic reference grammar — exhaustive token coverage — NT",
    "generic reference syntax — colon forms",
    "generic reference syntax — dot forms",
    "generic reference syntax — spaced forms",
    "generic reference syntax — chapter forms",
    "generic reference syntax — range forms",
    "generic aliases",
    "All 66 canonical"
  ]) {
    assert.ok(grouped[0].grep.includes(pattern), "batched grep must preserve: " + pattern);
  }
});

test("dedicated reference specs remain covered by individual or batched matrix entries", () => {
  const files = new Set(matrix.flatMap(entry => entry.files || (entry.file ? [entry.file] : [])));
  for (const spec of [
    "shared-regex-patterns",
    "redirect-source-url-patterns",
    "redirect-source-url-browser",
    "redirect-hostnames",
    "redirect-toggle-isolation",
    "multiverse-clipboard-reference-pattern",
    "popup-master-toggle-regression",
    "facebook-selection-parser",
    "substack-selection-parser",
    "omnibox-command-routing",
    "pdf-selection-regressions",
    "blb-non-kjv-redirect",
    "rediscover-sagacity-button",
    "research-dom-smoke"
  ]) {
    assert.ok(files.has("tests/browser/" + spec + ".spec.js"), "dedicated spec remains: " + spec);
  }
  for (const group of ["redirect-source-smoke-batch", "selection-parser-batch", "command-and-redirect-batch"]) {
    assert.ok(matrix.some(entry => entry.group === group && Array.isArray(entry.files) && entry.grep === ".*"), "batch retains coverage: " + group);
  }
});

test("reference matrix group names remain unique", () => {
  const groups = matrix.map(entry => entry.group);
  assert.equal(new Set(groups).size, groups.length);
});
