'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource, run } = require('./ast-symbol-reference-audit');

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

test('run inventories local bindings across extension and non-extension repository files', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-local-bindings-'));
  const originalLog = console.log;
  try {
    fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'runtime.js'),
      'function host() { function unusedRuntimeHelper() {} }');
    fs.writeFileSync(path.join(root, 'scripts', 'helper.js'),
      'function testTool() { const unusedToolLocal = 1; }');
    console.log = () => {};
    const result = run(root);
    const names = result.findings
      .filter(item => item.scope !== 'property-name-index')
      .map(item => item.name);
    assert.equal(result.files, 2);
    assert.deepEqual(names.sort(), ['unusedRuntimeHelper', 'unusedToolLocal']);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retains reviewed VM-injected globals and Playwright reporter lifecycle hooks', () => {
  const vmGlobal = analyzeSource(
    'const sandbox = { hostnameFromTabUrl: value => value };',
    'scripts/test-content-script-sender-document.js'
  );
  const reporterHook = analyzeSource(
    'class ProgressReporter { onBegin() {} }',
    'tests/browser/progress-reporter.js'
  );
  assert.deepEqual(vmGlobal, []);
  assert.deepEqual(reporterHook, []);
});
