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
    "Single-word verse cues resolve"
  ]) {
    assert.ok(grouped[0].grep.includes(pattern), "batched grep must preserve: " + pattern);
  }
  assert.doesNotMatch(grouped[0].grep, /Double-click resolves any part|Acts 7, v\\.25|Unicode-styled Bible book|spaced forms — OT|spaced forms — NT|Facebook directional-format Revelation/);
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
  const specialized = matrix.find(entry => entry.group === "specialized-reference-smoke-batch");
  assert.ok(specialized && specialized.files.length === 3, "specialized low-volume specs share one runner");
  for (const pattern of ["paired 1 & 2 Timothy whole-book shorthand reaches the final MultiVerse POST with every chapter", "Sagacity browser collector captures Matt\\. 12:37 from malformed nested BLB anchors", "D14", "D60"]) {
    assert.ok(specialized.grep.includes(pattern), "specialized batch retains grep coverage: " + pattern);
  }
  for (const group of ["redirect-source-smoke-batch", "selection-parser-batch", "command-and-redirect-batch"]) {
    assert.ok(matrix.some(entry => entry.group === group && Array.isArray(entry.files) && entry.grep === ".*"), "batch retains coverage: " + group);
  }
});

test("reference matrix group names remain unique", () => {
  const groups = matrix.map(entry => entry.group);
  assert.equal(new Set(groups).size, groups.length);
});
