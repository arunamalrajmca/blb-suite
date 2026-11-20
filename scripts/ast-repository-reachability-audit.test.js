'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeFile, discoverContexts, findCrossContextReferencedGlobals } = require('./ast-repository-reachability-audit');

test('a shared global used in one execution context is retained in every context', () => {
  const contexts = [
    { files: ['extension/shared.js'] },
    { files: ['extension/shared.js', 'extension/worker.js'] }
  ];
  const analyses = new Map([
    ['extension/shared.js', {
      definitions: [{ name: 'sharedHelper', kind: 'function', line: 1 }],
      ownReads: new Set(),
      unresolvedReads: new Set()
    }],
    ['extension/worker.js', {
      definitions: [],
      ownReads: new Set(),
      unresolvedReads: new Set(['sharedHelper'])
    }]
  ]);
  const referenced = findCrossContextReferencedGlobals(contexts, analyses);
  assert.ok(referenced.has('extension/shared.js:sharedHelper'));
});

test('collects top-level functions, classes, and function-valued globals', () => {
  const result = analyzeFile([
    'function topFunction() {}',
    'class TopClass {}',
    'const callback = () => true;',
    'const Klass = class {};',
    'function outer() { function localOnly() {} }'
  ].join('\n'), 'globals.js');
  assert.deepEqual(result.definitions.map(item => item.name), [
    'topFunction', 'TopClass', 'callback', 'Klass', 'outer'
  ]);
});

test('collects cross-file-relevant unresolved reads without confusing local bindings', () => {
  const result = analyzeFile([
    'function declaredHere() {}',
    'declaredHere();',
    'function caller() {',
    '  const localOnly = 1;',
    '  return localOnly + externalGlobal();',
    '}'
  ].join('\n'), 'scope.js');
  assert.ok(result.ownReads.has('declaredHere'));
  assert.ok(result.unresolvedReads.has('externalGlobal'));
});

test('collects static class and object function properties', () => {
  const result = analyzeFile([
    'class Example { run() {} }',
    'const service = { start: () => true };',
    'const instance = new Example();',
    'instance["run"]();',
    'service.start();'
  ].join('\n'), 'properties.js');
  assert.deepEqual(result.properties.map(item => item.name), ['run', 'start']);
  assert.ok(result.propertyReferences.has('run'));
  assert.ok(result.propertyReferences.has('start'));
});

test('marks eval and computed global access as dynamic-analysis risks', () => {
  const result = analyzeFile([
    'function hiddenMaybe() {}',
    'globalThis[name]();',
    'eval(source);'
  ].join('\n'), 'dynamic.js');
  assert.equal(result.dynamicRisk.length, 2);
});

test('discovers manifest and HTML execution contexts plus runtime registration sites', () => {
  const root = require('node:os').tmpdir();
  const source = new Map([
    ['extension/background.js', 'const STARTUP_IMPORTS = ["later.js"]; for (const scriptFile of STARTUP_IMPORTS) importScripts(scriptFile); chrome.scripting.registerContentScripts([]);'],
    ['extension/later.js', 'importScripts("nested.js"); function importedGlobal() {}'],
    ['extension/nested.js', 'function nestedGlobal() {}'],
    ['extension/content.js', 'function contentGlobal() {}'],
    ['extension/popup.js', 'function popupGlobal() {}']
  ]);
  const fakeRoot = require('node:fs').mkdtempSync(require('node:path').join(root, 'reachability-'));
  try {
    require('node:fs').mkdirSync(require('node:path').join(fakeRoot, 'extension'), { recursive: true });
    require('node:fs').writeFileSync(require('node:path').join(fakeRoot, 'extension/manifest.json'), JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'background.js' },
      content_scripts: [{ js: ['content.js'] }]
    }));
    require('node:fs').writeFileSync(require('node:path').join(fakeRoot, 'extension/popup.html'), '<script src="popup.js"></script>');
    const result = discoverContexts(fakeRoot, source);
    const worker = result.groups.find(group => group.id === 'mv3-service-worker');
    assert.ok(worker);
    assert.deepEqual(worker.files, ['extension/nested.js', 'extension/later.js', 'extension/background.js']);
    assert.ok(result.groups.some(group => group.id === 'manifest-content-script-0'));
    assert.ok(result.groups.some(group => group.id === 'html:extension/popup.html'));
    assert.ok(result.dynamic.some(item => item.api === 'chrome.scripting.registerContentScripts'));
    assert.ok(result.dynamic.some(item => item.api === 'importScripts'));
  } finally {
    require('node:fs').rmSync(fakeRoot, { recursive: true, force: true });
  }
});
