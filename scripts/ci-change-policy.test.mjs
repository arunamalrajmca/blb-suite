import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonRuntimePath, requiresPackageValidation } from './ci-change-policy.mjs';

test('repository audit tooling and workflow-only edits skip the expensive package regression suite', () => {
  for (const path of [
    'scripts/ast-symbol-reference-audit.js',
    'scripts/ast-cross-module-dynamic-reachability-audit.test.js',
    'scripts/classify-ast-audit-scope.mjs',
    '.github/workflows/browser-tests.yml',
    '.github/workflows/ci-command-router.yml'
  ]) {
    assert.equal(isNonRuntimePath(path), true, path);
    assert.equal(requiresPackageValidation(path), false, path);
  }
});

test('runtime and regression-suite inputs still require package validation', () => {
  for (const path of [
    'extension/background.js',
    'extension/manifest.json',
    'regression-suite/tests/package-tests.mjs',
    'package.json',
    'package-lock.json'
  ]) assert.equal(requiresPackageValidation(path), true, path);
});

test('selector and CI routing policy changes retain their targeted package validation', () => {
  for (const path of [
    'tests/selector/browser-selector-decisions.test.mjs',
    'scripts/select-browser-specs.mjs',
    'scripts/ci-change-policy.mjs',
    'scripts/test-ci-routing-selector.js'
  ]) assert.equal(requiresPackageValidation(path), true, path);
});
