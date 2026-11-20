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


test('does not treat Chrome executeScript func callbacks as object methods', () => {
  const findings = analyzeSource(
    'chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => true });',
    'execute-script-callback.js'
  );
  assert.deepEqual(findings, []);
});

test('does not mistake dynamic computed member keys for static property references', () => {
  const findings = analyzeSource(
    'class Example { run() {} } const instance = new Example(); instance[chosenMethod]();',
    'dynamic-computed.js'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, 'run');
});

test('recognizes computed string-literal property keys', () => {
  const findings = analyzeSource(
    'class Example { ["run"]() {} ["stop"]() {} } const instance = new Example(); instance["run"]();',
    'literal-computed.js'
  );
  assert.deepEqual(findings.map(item => item.name), ['stop']);
});

test('does not mistake dynamic computed class method names for static names', () => {
  const findings = analyzeSource(
    'const chosen = "run"; class Example { [chosen]() {} }',
    'dynamic-method-key.js'
  );
  assert.deepEqual(findings, []);
});

test('suppresses local candidates in direct-eval dynamic scopes', () => {
  const findings = analyzeSource([
    'function outer() {',
    '  const visibleToEval = 1;',
    '  eval("visibleToEval");',
    '}'
  ].join('\n'), 'eval-scope.js');
  assert.deepEqual(findings.filter(item => item.scope !== 'property-name-index'), []);
});

test('suppresses local candidates in with-statement dynamic scopes', () => {
  const findings = analyzeSource([
    'function outer(target) {',
    '  const potentiallyObserved = 1;',
    '  with (target) { void potentiallyObserved; }',
    '}'
  ].join('\n'), 'with-scope.js');
  assert.deepEqual(findings.filter(item => item.scope !== 'property-name-index'), []);
});
