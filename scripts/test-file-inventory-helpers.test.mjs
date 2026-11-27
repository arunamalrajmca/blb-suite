import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTestFileName } from './test-file-inventory-helpers.mjs';

test('recognizes supported test and spec filename conventions', () => {
  for (const name of [
    'test-example.js', 'test_example.mjs', 'spec-example.js', 'spec_example.cjs',
    'example.test.js', 'example.spec.mjs', 'custom-test-runner.js', 'custom-spec-runner.mjs'
  ]) assert.equal(looksLikeTestFileName(name), true, name);
});

test('does not classify ordinary source filenames as tests', () => {
  for (const name of ['testing-utils.js', 'specificity.js', 'example.js', 'specification.mjs']) {
    assert.equal(looksLikeTestFileName(name), false, name);
  }
});

test('extracts titles from real test declarations, including nested and multiline declarations', () => {
  const { extractDeclaredTestTitles } = requireForTestHelpers;
  assert.deepEqual(extractDeclaredTestTitles([
    "test('first declared test', async () => {});",
    "test.describe('group', () => { test(\"nested declared test\", () => {}); });",
    "it(\n  'multiline declaration',\n  () => {}\n);"
  ].join("\\n")), [
    'first declared test',
    'nested declared test',
    'multiline declaration'
  ]);
});
