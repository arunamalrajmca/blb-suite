import test from "node:test";
import assert from "node:assert/strict";
import { auditInputPaths, createAuditInputFingerprint } from "./ast-audit-input-fingerprint.mjs";

const tracked = [
  "extension/background.js",
  "extension/manifest.json",
  "extension/popup.html",
  "scripts/ast-symbol-reference-audit.js",
  "scripts/ast-symbol-reference-audit.test.js",
  "scripts/ast-owner-aware-node-reachability-audit.js",
  "scripts/ast-owner-aware-node-reachability-audit.test.js",
  "scripts/ast-unified-dynamic-runtime-reachability-audit.js",
  "scripts/ast-unified-dynamic-runtime-reachability-audit.test.js",
  "scripts/helper.mjs",
  "tests/browser/example.spec.js",
  ".github/workflows/browser-tests.yml",
  "package.json",
  "package-lock.json",
  "README.md"
];

test("AST fingerprints include every scanned source file and the analyzer's own test", () => {
  const symbol = auditInputPaths("symbol", tracked);
  assert.ok(symbol.includes("extension/background.js"));
  assert.ok(symbol.includes("tests/browser/example.spec.js"));
  assert.ok(symbol.includes("scripts/ast-symbol-reference-audit.test.js"));
  assert.ok(symbol.includes("package-lock.json"));
  assert.ok(!symbol.includes("extension/manifest.json"));
  assert.ok(!symbol.includes(".github/workflows/browser-tests.yml"));
});

test("Node module graph fingerprints exclude extension source but include workflow roots", () => {
  const files = auditInputPaths("cross_module", tracked);
  assert.ok(files.includes("tests/browser/example.spec.js"));
  assert.ok(files.includes(".github/workflows/browser-tests.yml"));
  assert.ok(files.includes("scripts/ast-owner-aware-node-reachability-audit.test.js"));
  assert.ok(!files.includes("extension/background.js"));
  assert.ok(!files.includes("extension/manifest.json"));
});

test("executable-source fingerprint is limited to extension packaged inputs", () => {
  const files = auditInputPaths("executable_source", tracked);
  assert.ok(files.includes("extension/background.js"));
  assert.ok(files.includes("extension/manifest.json"));
  assert.ok(files.includes("extension/popup.html"));
  assert.ok(files.includes("scripts/ast-executable-source-coverage-audit.test.js"));
  assert.ok(!files.includes("tests/browser/example.spec.js"));
  assert.ok(!files.includes(".github/workflows/browser-tests.yml"));
});

test("owner and unified fingerprints include manifests and workflow execution roots", () => {
  for (const name of ["owner", "unified"]) {
    const files = auditInputPaths(name, tracked);
    assert.ok(files.includes("extension/manifest.json"));
    assert.ok(files.includes(".github/workflows/browser-tests.yml"));
    assert.ok(files.includes("scripts/ast-" + (name === "owner" ? "owner-aware-node" : "unified-dynamic-runtime") + "-reachability-audit.test.js"));
  }
});

test("fingerprints are stable regardless of input ordering and change when any input changes", () => {
  const first = [
    { path: "a.js", content: Buffer.from("const a = 1;") },
    { path: "b.js", content: Buffer.from("const b = 2;") }
  ];
  assert.equal(createAuditInputFingerprint(first), createAuditInputFingerprint([...first].reverse()));
  assert.notEqual(createAuditInputFingerprint(first), createAuditInputFingerprint([
    first[0], { path: "b.js", content: Buffer.from("const b = 3;") }
  ]));
  assert.notEqual(createAuditInputFingerprint(first), createAuditInputFingerprint([
    ...first, { path: "c.js", content: Buffer.from("const c = 4;") }
  ]));
});

test("unknown audit names fail closed", () => {
  assert.throws(() => auditInputPaths("unknown", tracked), /Unknown AST audit/);
});
