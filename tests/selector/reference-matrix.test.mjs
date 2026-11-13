import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const matrix = JSON.parse(readFileSync(
  new URL("../../scripts/reference-e2e-matrix.json", import.meta.url),
  "utf8"
));

test("extension reference coverage is split into disjoint parallel matrix groups without losing tests", () => {
  const groups = matrix.filter(entry => entry.group.startsWith("extension-spec-reference"));
  assert.equal(groups.length, 5);
  assert.deepEqual(groups.map(entry => entry.group), [
    "extension-spec-reference-coverage",
    "extension-spec-reference-grammar-forms",
    "extension-spec-reference-aliases",
    "extension-spec-reference-canonical-books",
    "extension-spec-reference-same-chapter-ranges"
  ]);
  for (const entry of groups) {
    assert.equal(entry.file, undefined);
    assert.doesNotThrow(() => new RegExp(entry.grep));
  }
  const source = readFileSync(new URL("../browser/extension-reference-actions.spec.js", import.meta.url), "utf8");
  const titles = [...source.matchAll(/test\\('([^']+)'/g)].map(match => match[1]);
  const previousCoverage = new RegExp("(?:Double-click resolves any part|positional context|browser token|separate lines|standalone book numbers|ordinary heading words)|(?:generic reference grammar — exhaustive token coverage — OT)|(?:generic reference grammar — exhaustive token coverage — NT)|(?:generic reference syntax — colon forms)|(?:generic reference syntax — dot forms)|(?:generic reference syntax — spaced forms)|(?:generic reference syntax — chapter forms)|(?:generic reference syntax — range forms)|(?:generic aliases|numbered aliases and Roman prefixes|standalone Roman prefixes)|(?:All 66 canonical)|(?:Same-chapter ranges — all 66 books through)|(?:Same-chapter range resolution covers all 66 books on Double-Click)");
  const previouslySelected = titles.filter(title => previousCoverage.test(title));
  assert.ok(previouslySelected.length >= 15, "the former large grep must resolve to its original test-title inventory");
  for (const title of previouslySelected) {
    const matches = groups.filter(entry => new RegExp(entry.grep).test(title));
    assert.equal(matches.length, 1, "reference test must be selected exactly once: " + title);
  }
});

test("dedicated reference specs remain covered by individual or batched matrix entries", () => {
  const files = new Set(matrix.flatMap(entry => entry.files || (entry.file ? [entry.file] : [])));
  for (const spec of [
    "shared-regex-patterns",
    "redirect-source-url-patterns",
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
