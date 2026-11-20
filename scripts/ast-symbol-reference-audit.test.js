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


test('recognizes class and object methods referenced through static member access', () => {
  const source = [
    'class Worker {',
    '  run() {}',
    '  stop() {}',
    '}',
    'const worker = new Worker();',
    'worker.run();',
    'const service = {',
    '  start: () => {},',
    '  stop: function () {}',
    '};',
    'service.start();'
  ].join('\n');
  const findings = analyzeSource(source, 'properties.js');
  assert.deepEqual(
    findings.filter(item => item.scope === 'property-name-index').map(item => item.name),
    ['stop', 'stop']
  );
});

test('reports unreferenced static method names only as review candidates', () => {
  const findings = analyzeSource(
    'class Example { unusedMethod() {} }',
    'unused-property.js'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, 'unusedMethod');
  assert.equal(findings[0].confidence, 'candidate-only');
  assert.match(findings[0].reason, /dynamic\/computed\/reflection-based access/);
});

test('recognizes string-literal computed member access', () => {
  const findings = analyzeSource(
    'class Example { run() {} } const instance = new Example(); instance["run"]();',
    'computed-static.js'
  );
  assert.deepEqual(findings, []);
});


test('uses static property references from other extension files', () => {
  const findings = analyzeSource(
    'const api = { sharedMethod: () => {} };',
    'shared-api.js',
    new Set(['sharedMethod'])
  );
  assert.deepEqual(findings, []);
});


test('parses module syntax when repository files use import or export', () => {
  const findings = analyzeSource(
    'export function exportedHelper() {}',
    'module-file.js'
  );
  assert.deepEqual(findings, []);
});
