import test from "node:test";
import assert from "node:assert/strict";
import { selectAstAudits } from "./classify-ast-audit-scope.mjs";

test("analyzer changes select only their own audit plus declared graph consumers", () => {
  assert.deepEqual(selectAstAudits(["scripts/ast-symbol-reference-audit.js"]), ["symbol"]);
  assert.deepEqual(selectAstAudits(["scripts/ast-repository-reachability-audit.test.js"]), ["repository"]);
  assert.deepEqual(selectAstAudits(["scripts/ast-runtime-flow-reachability-audit.js"]), ["runtime", "unified"]);
  assert.deepEqual(selectAstAudits(["scripts/ast-unified-dynamic-runtime-reachability-audit.js"]), ["cross_module", "unified"]);
  assert.deepEqual(selectAstAudits(["scripts/ast-owner-aware-node-reachability-audit.js"]), ["owner", "cross_module", "unified"]);
  assert.deepEqual(selectAstAudits(["scripts/ast-computed-property-reachability-audit.js"]), ["computed"]);
  assert.deepEqual(selectAstAudits(["scripts/ast-executable-source-coverage-audit.js"]), ["executable_source"]);
  assert.deepEqual(selectAstAudits(["scripts/ast-runtime-metaprogramming-uncertainty-audit.js"]), ["metaprogramming"]);
});

test("extension JavaScript changes select every whole-repository JS consumer but not the Node-only graph", () => {
  assert.deepEqual(selectAstAudits(["extension/background.js"]),
    ["symbol", "repository", "owner", "runtime", "unified", "computed", "executable_source", "metaprogramming"]);
});

test("extension manifest and HTML changes select only metadata/execution-root consumers", () => {
  assert.deepEqual(selectAstAudits(["extension/manifest.json"]),
    ["repository", "owner", "unified", "executable_source"]);
  assert.deepEqual(selectAstAudits(["extension/popup.html"]),
    ["repository", "owner", "unified", "executable_source"]);
});

test("non-extension JavaScript changes select all repository-wide source consumers", () => {
  assert.deepEqual(selectAstAudits(["tests/browser/example.spec.js"]),
    ["symbol", "repository", "owner", "cross_module", "runtime", "unified", "computed", "metaprogramming"]);
  assert.deepEqual(selectAstAudits(["scripts/helper.mjs"]),
    ["symbol", "repository", "owner", "cross_module", "runtime", "unified", "computed", "metaprogramming"]);
});

test("workflow and composite-action execution roots select only graph-root consumers", () => {
  assert.deepEqual(selectAstAudits([".github/workflows/browser-tests.yml"]), ["owner", "cross_module", "unified"]);
  assert.deepEqual(selectAstAudits([".github/actions/nested/action/action.yaml"]), ["owner", "cross_module", "unified"]);
});

test("shared package/parser inputs and unknown AST helper files fail safe to all audits", () => {
  for (const path of [
    "package.json", "package-lock.json", "scripts/classify-ast-audit-scope.mjs",
    "scripts/ast-audit-input-fingerprint.mjs", "scripts/ast-shared-utils.js",
    "scripts/ast-new-shared-helper.js"
  ]) assert.equal(selectAstAudits([path]).length, 9, path);
});

test("manual full audit selection runs every audit", () => {
  assert.equal(selectAstAudits([], { full: true }).length, 9);
});

test("unrelated documentation and styling changes select no AST audits", () => {
  assert.deepEqual(selectAstAudits(["README.md", "docs/audit-notes.md", "extension/popup.css"]), []);
});

test("multiple changes union their selected audit dependencies", () => {
  assert.deepEqual(selectAstAudits(["extension/background.js", ".github/workflows/browser-tests.yml"]),
    ["symbol", "repository", "owner", "cross_module", "runtime", "unified", "computed", "executable_source", "metaprogramming"]);
});
