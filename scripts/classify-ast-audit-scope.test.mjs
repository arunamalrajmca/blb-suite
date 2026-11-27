import test from "node:test";
import assert from "node:assert/strict";
import { selectAstAudits } from "./classify-ast-audit-scope.mjs";

const nonExtensionJs = ["symbol", "repository", "owner", "cross_module", "runtime", "unified", "computed", "metaprogramming"];
const nonExtensionModules = ["owner", "cross_module", "runtime", "unified", "computed", "metaprogramming"];

test("analyzer JavaScript changes rerun every whole-repository scanner that parses them", () => {
  for (const path of [
    "scripts/ast-symbol-reference-audit.js",
    "scripts/ast-repository-reachability-audit.test.js",
    "scripts/ast-owner-aware-node-reachability-audit.js",
    "scripts/ast-cross-module-dynamic-reachability-audit.test.js",
    "scripts/ast-runtime-flow-reachability-audit.js",
    "scripts/ast-unified-dynamic-runtime-reachability-audit.test.js",
    "scripts/ast-computed-property-reachability-audit.js",
    "scripts/ast-runtime-metaprogramming-uncertainty-audit.js"
  ]) assert.deepEqual(selectAstAudits([path]), nonExtensionJs, path);
});

test("the executable-source analyzer's own source change also selects its extension-only audit", () => {
  assert.deepEqual(selectAstAudits(["scripts/ast-executable-source-coverage-audit.js"]),
    ["symbol", "repository", "owner", "cross_module", "runtime", "unified", "computed", "executable_source", "metaprogramming"]);
});

test("module-format changes select only scanners that parse CJS/MJS files", () => {
  assert.deepEqual(selectAstAudits(["scripts/helper.mjs"]), nonExtensionModules);
  assert.deepEqual(selectAstAudits(["scripts/helper.cjs"]), nonExtensionModules);
  assert.deepEqual(selectAstAudits(["scripts/classify-ast-audit-scope.test.mjs"]), nonExtensionModules);
});

test("extension JavaScript changes select every whole-repository JS consumer but not the Node-only graph", () => {
  assert.deepEqual(selectAstAudits(["extension/background.js"]),
    ["symbol", "repository", "owner", "runtime", "unified", "computed", "executable_source", "metaprogramming"]);
});

test("extension module-format changes select consumers of extension CJS/MJS plus executable-source", () => {
  assert.deepEqual(selectAstAudits(["extension/background.mjs"]),
    ["owner", "runtime", "unified", "computed", "executable_source", "metaprogramming"]);
});

test("extension manifest and HTML changes select only metadata/execution-root consumers", () => {
  assert.deepEqual(selectAstAudits(["extension/manifest.json"]),
    ["repository", "owner", "unified", "executable_source"]);
  assert.deepEqual(selectAstAudits(["extension/popup.html"]),
    ["repository", "owner", "unified", "executable_source"]);
});

test("non-extension JavaScript changes select all repository-wide source consumers", () => {
  assert.deepEqual(selectAstAudits(["tests/browser/example.spec.js"]), nonExtensionJs);
});


test("standalone HTML and JSON changes select the consumers that inspect those inputs", () => {
  assert.deepEqual(selectAstAudits(["docs/reference.html"]), ["repository"]);
  assert.deepEqual(selectAstAudits(["scripts/runtime-data.json"]), ["owner", "cross_module", "unified"]);
  assert.deepEqual(selectAstAudits(["scripts/manifest-data.json"]), ["repository", "owner", "cross_module", "unified"]);
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
