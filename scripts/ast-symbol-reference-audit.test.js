'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource } = require('./ast-symbol-reference-audit');

test('reports unread local declarations but not referenced bindings', () => {
  const source = [
    'function sample(input) {',
    '  const used = input;',
    '  console.log(used);',
    '  const unread = 42;',
    '  function neverCalled() {}',
    '  class UnusedClass {}',
    '}'
  ].join('\n');

  const findings = analyzeSource(source, 'fixture.js');
  assert.deepEqual(findings.map(item => item.name), [
    'unread', 'neverCalled', 'UnusedClass'
  ]);
  assert.ok(findings.every(item => item.file === 'fixture.js'));
  assert.ok(findings.every(item => item.confidence === 'candidate-only'));
});

test('does not label cross-file-capable global declarations as unused', () => {
  const findings = analyzeSource('function sharedAcrossClassicScripts() {}');
  assert.deepEqual(findings, []);
});

test('does not report a local binding that is read by a nested closure', () => {
  const findings = analyzeSource(
    'function outer() { const captured = 1; return () => captured; }'
  );
  assert.deepEqual(findings, []);
});

test('syntax errors are surfaced rather than silently ignored', () => {
  assert.throws(() => analyzeSource('function broken( {'));
});
