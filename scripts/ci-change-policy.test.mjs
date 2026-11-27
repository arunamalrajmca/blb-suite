import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonRuntimePath, requiresPackageValidation, requiresPackageRegression } from './ci-change-policy.mjs';

test('repository audit tooling and workflow-only edits skip the expensive package regression suite', () => {
  for (const path of [
    'scripts/ast-symbol-reference-audit.js',
    'scripts/ast-cross-module-dynamic-reachability-audit.test.js',
    'scripts/classify-ast-audit-scope.mjs',
    'scripts/ci-change-policy.test.mjs',
    'scripts/ci-section-checkpoint.mjs',
    'scripts/ci-section-checkpoint.test.mjs',
    'scripts/ci-checkpoint-fingerprints.mjs',
    'scripts/ci-checkpoint-fingerprints.test.mjs',
    'scripts/run-checkpointed-playwright-audit.mjs',
    '.github/workflows/browser-tests.yml',
    '.github/workflows/ci-command-router.yml',
    '.github/actions/ci-section-checkpoint/action.yml',
    'scripts/ci-change-policy.mjs',
    'scripts/classify-ci-changes.mjs'
  ]) {
    assert.equal(isNonRuntimePath(path), true, path);
    assert.equal(requiresPackageValidation(path), true, path);
    assert.equal(requiresPackageRegression(path), false, path);
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
    'scripts/test-ci-routing-selector.js'
  ]) assert.equal(requiresPackageValidation(path), true, path);
});


test('the package regression runner is limited to its actual source and dependency inputs', () => {
  for (const path of ['extension/background.js', 'extension/manifest.json', 'regression-suite/tests/package-tests.mjs', 'package.json', 'package-lock.json']) {
    assert.equal(requiresPackageRegression(path), true, path);
  }
  for (const path of ['scripts/ast-symbol-reference-audit.js', 'scripts/ci-change-policy.mjs', 'scripts/ci-section-checkpoint.test.mjs', '.github/workflows/browser-tests.yml', '.github/actions/ci-section-checkpoint/action.yml', 'tests/selector/browser-selector-decisions.test.mjs']) {
    assert.equal(requiresPackageRegression(path), false, path);
  }
});
