import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonRuntimePath, requiresPackageValidation, requiresPackageRegression } from './ci-change-policy.mjs';

test('AST audit tooling runs audit validation but skips the expensive package regression', () => {
  for (const path of [
    'scripts/ast-symbol-reference-audit.js',
    'scripts/ast-cross-module-dynamic-reachability-audit.test.js',
    'scripts/classify-ast-audit-scope.mjs',
    'scripts/classify-ast-audit-scope.test.mjs'
  ]) {
    assert.equal(isNonRuntimePath(path), true, path);
    assert.equal(requiresPackageValidation(path), true, path);
    assert.equal(requiresPackageRegression(path), false, path);
  }
});

test('workflow and checkpoint-only edits skip package and runtime regression work', () => {
  for (const path of [
    '.github/workflows/browser-tests.yml',
    '.github/workflows/ci-command-router.yml',
    '.github/actions/ci-section-checkpoint/action.yml',
    'scripts/ci-change-policy.mjs',
    'scripts/ci-change-policy.test.mjs',
    'scripts/classify-ci-changes.mjs',
    'scripts/ci-section-checkpoint.mjs',
    'scripts/ci-section-checkpoint.test.mjs',
    'scripts/ci-checkpoint-fingerprints.mjs',
    'scripts/ci-checkpoint-fingerprints.test.mjs',
    'scripts/run-checkpointed-playwright-audit.mjs'
  ]) {
    assert.equal(isNonRuntimePath(path), true, path);
    assert.equal(requiresPackageValidation(path), false, path);
    assert.equal(requiresPackageRegression(path), false, path);
  }
});

test('runtime and regression-suite inputs still require package validation and package regressions', () => {
  for (const path of [
    'extension/background.js',
    'extension/manifest.json',
    'regression-suite/tests/package-tests.mjs',
    'package.json',
    'package-lock.json'
  ]) {
    assert.equal(requiresPackageValidation(path) || !isNonRuntimePath(path), true, path);
    assert.equal(requiresPackageRegression(path), true, path);
  }
});

test('selector and CI routing changes retain their targeted validation without running package regressions', () => {
  for (const path of [
    'tests/selector/browser-selector-decisions.test.mjs',
    'scripts/select-browser-specs.mjs',
    'scripts/test-ci-routing-selector.js'
  ]) {
    assert.equal(requiresPackageValidation(path), true, path);
    assert.equal(requiresPackageRegression(path), false, path);
  }
});
