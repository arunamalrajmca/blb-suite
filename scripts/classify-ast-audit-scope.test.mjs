import test from "node:test";
import assert from "node:assert/strict";
import { selectAstAudits } from "./classify-ast-audit-scope.mjs";

test("a runtime-flow analyzer change runs only runtime-flow and unified audits", () => {
  assert.deepEqual(selectAstAudits([
    "scripts/ast-runtime-flow-reachability-audit.js",
    "scripts/ast-runtime-flow-reachability-audit.test.js"
  ]), ["runtime", "unified"]);
});

test("owner-aware changes also run dependent cross-module and unified audits", () => {
  assert.deepEqual(selectAstAudits(["scripts/ast-owner-aware-node-reachability-audit.js"]),
    ["owner", "cross_module", "unified"]);
});

test("each independent analyzer change selects its own audit", () => {
  for (const name of ["symbol", "repository", "cross_module", "computed"]) {
    const path = ({
      symbol: "scripts/ast-symbol-reference-audit.test.js",
      repository: "scripts/ast-repository-reachability-audit.js",
      cross_module: "scripts/ast-cross-module-dynamic-reachability-audit.test.js",
      computed: "scripts/ast-computed-property-reachability-audit.js"
    })[name];
    assert.deepEqual(selectAstAudits([path]), [name]);
  }
});

test("parser/dependency/workflow/shared checkpoint changes run every audit", () => {
  for (const path of ["package-lock.json", "package.json", ".github/workflows/browser-tests.yml",
    ".github/actions/ci-section-checkpoint/action.yml", "scripts/ast-new-shared-helper.js"]) {
    assert.equal(selectAstAudits([path]).length, 7, path);
  }
});

test("manual full audit selection runs every audit", () => {
  assert.equal(selectAstAudits([], { full: true }).length, 7);
});

test("unrelated changes select no AST audits", () => {
  assert.deepEqual(selectAstAudits(["extension/popup.js", "README.md"]), []);
});
