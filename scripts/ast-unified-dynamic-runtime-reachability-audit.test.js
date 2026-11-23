'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('./ast-unified-dynamic-runtime-reachability-audit');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-runtime-graph-'));
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return root;
}
function run(files) {
  const root = fixture(files);
  try { return analyze(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function edge(result, kind, from, to) {
  return result.edges.some(item => item.kind === kind && item.from === from && item.to === to);
}


test('resolves named callback owners passed through a same-module registration wrapper', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) { return message; }',
      'function register(callback) { chrome.runtime.onMessage.addListener(callback); }',
      'register(onMessage);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' && item.expression === 'chrome.runtime.onMessage.addListener'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument', JSON.stringify(registration));
  assert.ok(registration.callbackTarget.endsWith('::onMessage@1:9'), registration.callbackTarget);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});


test('propagates callback owners through multiple wrapper parameters and local aliases', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) { return message; }',
      'function registerInner(callback) { chrome.runtime.onMessage.addListener(callback); }',
      'function registerMiddle(handler) { const forwarded = handler; registerInner(forwarded); }',
      'function registerOuter(callback) { registerMiddle(callback); }',
      'registerOuter(onMessage);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item => item.kind === 'external-callback-registration');
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.ok(registration.callbackTarget.endsWith('::onMessage@1:9'), registration.callbackTarget);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('keeps nested callback wrappers uncertain when an intermediate parameter has no known caller', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function registerInner(callback) { chrome.runtime.onMessage.addListener(callback); }',
      'function registerOuter(handler) { registerInner(handler); }'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item => item.kind === 'external-callback-registration');
  assert.ok(registration);
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 1);
});



test('resolves callback owners passed through object-literal method wrappers', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) { return message; }',
      'const registrar = { register(callback) { chrome.runtime.onMessage.addListener(callback); } };',
      'registrar.register(onMessage);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item => item.kind === 'external-callback-registration');
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.match(registration.callbackTarget, /scripts\/main\.js::onMessage@1:/);
  assert.equal(registration.callbackTarget, registration.resolved);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('resolves callback owners passed through aliased object-literal method wrappers', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) { return message; }',
      'const registrar = { register: callback => chrome.runtime.onMessage.addListener(callback) };',
      'const alias = registrar;',
      'alias.register(onMessage);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item => item.kind === 'external-callback-registration');
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.match(registration.callbackTarget, /scripts\/main\.js::onMessage@1:/);
  assert.equal(registration.callbackTarget, registration.resolved);
});


test('resolves callback owners through cyclic wrapper forwarding without losing known roots', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) { return message; }',
      'function registerFirst(callback) { registerSecond(callback); }',
      'function registerSecond(callback) { registerFirst(callback); chrome.runtime.onMessage.addListener(callback); }',
      'registerFirst(onMessage);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item => item.kind === 'external-callback-registration');
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.match(registration.callbackTarget, /::onMessage@1:/);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('resolves callback wrappers declared as arrow-function variables', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) { return message; }',
      'const register = callback => chrome.runtime.onMessage.addListener(callback);',
      'register(onMessage);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item => item.kind === 'external-callback-registration');
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.match(registration.callbackTarget, /::onMessage@1:/);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('resolves callback owners through an imported registration wrapper', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/registrar.js': 'export function register(callback) { chrome.runtime.onMessage.addListener(callback); }',
    'scripts/main.js': "import { register } from './registrar.js'; function onMessage(message) { return message; } register(onMessage);"
  });
  const registration = result.dynamicSites.find(item =>
    item.file === 'scripts/registrar.js' && item.kind === 'external-callback-registration'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.ok(registration.callbackTarget.endsWith('::onMessage@1:52'), registration.callbackTarget);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});


test('resolves callback wrappers imported through a named re-export alias', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/registrar.js': 'export function register(callback) { chrome.runtime.onMessage.addListener(callback); }',
    'scripts/barrel.js': "export { register as subscribe } from './registrar.js';",
    'scripts/main.js': "import { subscribe } from './barrel.js'; function onMessage(message) { return message; } subscribe(onMessage);"
  });
  const registration = result.dynamicSites.find(item =>
    item.file === 'scripts/registrar.js' && item.kind === 'external-callback-registration'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.match(registration.callbackTarget, /::onMessage@1:/);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
  assert.ok(edge(result, 'function-call', 'scripts/main.js', 'scripts/registrar.js'));
});

test('resolves callback wrappers imported through an export-star barrel', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/registrar.js': 'export function register(callback) { chrome.runtime.onMessage.addListener(callback); }',
    'scripts/barrel.js': "export * from './registrar.js';",
    'scripts/main.js': "import { register } from './barrel.js'; function onMessage(message) { return message; } register(onMessage);"
  });
  const registration = result.dynamicSites.find(item =>
    item.file === 'scripts/registrar.js' && item.kind === 'external-callback-registration'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.match(registration.callbackTarget, /::onMessage@1:/);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});


test('does not expose a default callback wrapper through export-star', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/registrar.js': 'export default function register(callback) { chrome.runtime.onMessage.addListener(callback); }',
    'scripts/barrel.js': "export * from './registrar.js';",
    'scripts/main.js': "import register from './barrel.js'; function onMessage(message) { return message; } register(onMessage);"
  });
  const registration = result.dynamicSites.find(item =>
    item.file === 'scripts/registrar.js' && item.kind === 'external-callback-registration'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 1);
});

test('keeps callback parameters uncertain when another callsite supplies an unknown value', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) {}',
      'function register(callback) { chrome.runtime.onMessage.addListener(callback); }',
      'register(onMessage); register(getRuntimeCallback());'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item => item.kind === 'external-callback-registration');
  assert.ok(registration);
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 1);
});

test('keeps callback parameters uncertain when callsites disagree on the owner', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function first(message) {}',
      'function second(message) {}',
      'function register(callback) { chrome.runtime.onMessage.addListener(callback); }',
      'register(first); register(second);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item => item.kind === 'external-callback-registration');
  assert.ok(registration);
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 1);
});

test('resolves dynamic import, importScripts, executeScript files, and registered content scripts', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "const plugin = './plugins/' + 'alpha.js'; import(plugin); importScripts('./worker-extra.js');",
    'scripts/plugins/alpha.js': 'export const active = true;',
    'scripts/worker-extra.js': 'self.ready = true;',
    'extension/manifest.json': JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'background/worker.js' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
    }),
    'extension/background/worker.js': "chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['scripts/injected.js'] }); chrome.scripting.registerContentScripts([{ id: 'late', js: [{ file: 'scripts/registered.js' }] }]); const script = document.createElement('script'); script.src = 'scripts/dom-injected.js'; document.head.appendChild(script);",
    'extension/content.js': 'void 0;',
    'extension/scripts/injected.js': 'void 0;',
    'extension/scripts/registered.js': 'void 0;',
    'extension/scripts/dom-injected.js': 'void 0;'
  });
  assert.equal(result.parseErrors.length, 0);
  assert.ok(result.roots.includes('scripts/main.js'));
  assert.ok(result.roots.includes('extension/background/worker.js'));
  assert.ok(result.roots.includes('extension/content.js'));
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'scripts/plugins/alpha.js'));
  assert.ok(edge(result, 'importScripts', 'scripts/main.js', 'scripts/worker-extra.js'));
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'extension/background/worker.js', 'extension/scripts/injected.js'));
  assert.ok(edge(result, 'chrome.scripting.registerContentScripts', 'extension/background/worker.js', 'extension/scripts/registered.js'));
  assert.ok(edge(result, 'dom-script-src-injection', 'extension/background/worker.js', 'extension/scripts/dom-injected.js'));
});


test('includes extension HTML script entrypoints and packaged data fallback dependencies', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'module.exports = true;',
    'extension/manifest.json': JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'background.js' },
      options_page: 'Tutorial.html'
    }),
    'extension/background.js': "async function fetchPackagedJsonAssignment(filename) { return fetch(chrome.runtime.getURL(filename)); } const fallbackAssignments = { 'corpus.json.gz': ['corpus-fallback.js', 'const CORPUS = ', ';'] }; async function loadWords() { return fetchPackagedJsonAssignment('words-fallback.js'); }",
    'extension/Tutorial.html': '<script src="Tutorial.js"></script>',
    'extension/Tutorial.js': 'globalThis.guide = true;',
    'extension/multiverse-post.html': '<script src="multiverse-post.js"></script>',
    'extension/multiverse-post.js': 'globalThis.handoff = true;',
    'extension/words-fallback.js': 'const WORDS = [];',
    'extension/corpus-fallback.js': 'const CORPUS = [];'
  });
  assert.ok(result.roots.includes('extension/Tutorial.js'));
  assert.ok(result.roots.includes('extension/multiverse-post.js'));
  assert.ok(edge(result, 'packaged-data-fetch', 'extension/background.js', 'extension/words-fallback.js'));
  assert.ok(edge(result, 'packaged-data-fallback', 'extension/background.js', 'extension/corpus-fallback.js'));
  assert.ok(result.reachable.includes('extension/Tutorial.js'));
  assert.ok(result.reachable.includes('extension/multiverse-post.js'));
  assert.ok(result.reachable.includes('extension/words-fallback.js'));
  assert.ok(result.reachable.includes('extension/corpus-fallback.js'));
});


test('discovers Playwright specs and GitHub Actions Node commands as execution roots', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { test: 'playwright test' } }),
    'playwright.config.js': "module.exports = { testDir: './tests/browser', reporter: [['./tests/browser/progress-reporter.js']] };",
    'tests/browser/example.spec.js': 'test("example", async () => {});',
    'tests/browser/progress-reporter.js': 'module.exports = class Reporter {};',
    'tests/selector/contract.test.mjs': 'export const ready = true;',
    'scripts/test-sample.js': 'module.exports = true;',
    '.github/workflows/ci.yml': "jobs:\\n  checks:\\n    steps:\\n      - run: node --test scripts/ci-check.test.js\\n      - run: node --test tests/selector/*.test.mjs\\n      - run: node regression-suite/tests/run-regression.mjs extension\\n      - run: for test_file in scripts/test-*.js; do node \"$test_file\"; done",
    'scripts/ci-check.test.js': "require('./ci-helper.js');",
    'scripts/ci-helper.js': 'module.exports = true;',
    'regression-suite/tests/run-regression.mjs': 'export const ready = true;'
  });
  assert.ok(result.roots.includes('playwright.config.js'));
  assert.ok(result.roots.includes('tests/browser/example.spec.js'));
  assert.ok(result.roots.includes('tests/browser/progress-reporter.js'));
  assert.ok(result.roots.includes('tests/selector/contract.test.mjs'));
  assert.ok(result.roots.includes('scripts/test-sample.js'));
  assert.ok(result.roots.includes('scripts/ci-check.test.js'));
  assert.ok(result.roots.includes('regression-suite/tests/run-regression.mjs'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/ci-check.test.js', 'scripts/ci-helper.js'));
});


test('resolves service-worker global content-script arrays referenced by browser test injections', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { test: 'playwright test' } }),
    'playwright.config.js': "module.exports = { testDir: './tests/browser' };",
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }),
    'extension/background.js': "const BLB_CONTENT_SCRIPT_FILES = ['content.js', 'collector.js']; const SCRIPT_TAGGER_CONTENT_SCRIPT_FILES = ['tagger.js'];",
    'extension/content.js': 'globalThis.content = true;',
    'extension/collector.js': 'globalThis.collector = true;',
    'extension/tagger.js': 'globalThis.tagger = true;',
    'tests/browser/injection.spec.js': "async function reinject(worker, id) { await worker.evaluate(async tabId => { await chrome.scripting.executeScript({ target: { tabId }, files: BLB_CONTENT_SCRIPT_FILES }); }, id); }"
  });
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'tests/browser/injection.spec.js', 'extension/content.js'));
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'tests/browser/injection.spec.js', 'extension/collector.js'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'chrome.scripting.executeScript.files').length, 0);
});

test('propagates imported function calls and object/callback parameter bindings across modules', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import { service } from './service.js'; import { invoke } from './helper.js'; invoke(service, () => service.start()); setTimeout(() => service.start(), 1);",
    'scripts/helper.js': 'export function invoke(target, callback) { target.start(); callback(); }',
    'scripts/service.js': 'export const service = { start() {} };'
  });
  assert.ok(edge(result, 'static-import', 'scripts/main.js', 'scripts/helper.js'));
  assert.ok(edge(result, 'function-call', 'scripts/main.js', 'scripts/helper.js'));
  assert.ok(result.edges.some(item => item.kind === 'cross-module-binding-import' && item.file === 'scripts/main.js' && item.detail === 'service'));
  assert.ok(result.dynamicSites.some(item => item.kind === 'cross-module-property-read' && item.expression === 'service[start]' && item.certainty === 'resolved-property-key'));
  assert.ok(result.edges.some(item => item.kind === 'function-argument' && item.file === 'scripts/main.js'));
  assert.ok(result.edges.some(item => item.kind === 'runtime-flow:callback-registration'));
  assert.ok(result.edges.some(item => item.kind === 'runtime-flow:closure-capture'));
  assert.ok(result.dynamicSites.some(item => item.kind === 'callback-argument' && item.certainty === 'resolved-inline-callback'));
});


test('propagates object identity returned by an imported helper into the caller', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/service.js': 'export const service = { start() {} };',
    'scripts/helper.js': "import { service } from './service.js'; export function getService() { return service; }",
    'scripts/main.js': "import { getService } from './helper.js'; const result = getService(); result.start();"
  });
  assert.ok(edge(result, 'function-call', 'scripts/main.js', 'scripts/helper.js'));
  assert.ok(edge(result, 'cross-module-function-return', 'scripts/helper.js', 'scripts/main.js'));
  assert.ok(result.edges.some(item => item.kind === 'cross-module-binding-import' && item.file === 'scripts/helper.js'));
});

test('connects container writes to reads and records constant computed property keys', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "const registry = new Map(); const handler = () => run(); registry.set('ready', handler); const selected = registry.get('ready'); const key = 'start'; service[key]();"
  });
  assert.ok(result.edges.some(item => item.kind === 'container-store'));
  assert.ok(result.edges.some(item => item.kind === 'container-read'));
  assert.ok(result.dynamicSites.some(item => item.kind === 'constant-computed-property' && item.expression === 'start'));
});

test('keeps shadowed constants distinct and does not falsely resolve a dynamic import', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "const plugin = './plugins/known.js'; function load() { const plugin = process.env.PLUGIN; return import(plugin); }",
    'scripts/plugins/known.js': 'export default true;'
  });
  const site = result.dynamicSites.find(item => item.kind === 'dynamic-import');
  assert.ok(site);
  assert.equal(site.resolved, null);
  assert.equal(site.certainty, 'unresolved-dynamic-import');
  assert.deepEqual(site.affectedRoots, ['scripts/main.js']);
});

test('scopes unresolved dynamic uncertainty to roots that can reach its source', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { first: 'node scripts/first.js', second: 'node scripts/second.js' } }),
    'scripts/first.js': "import('./plugins/' + process.env.PLUGIN);",
    'scripts/second.js': 'module.exports = true;',
    'scripts/plugins/known.js': 'module.exports = true;',
    'scripts/other/unused.js': 'module.exports = false;'
  });
  const site = result.uncertainty.find(item => item.kind === 'dynamic-import');
  assert.ok(site);
  assert.deepEqual(site.affectedRoots, ['scripts/first.js']);
  assert.equal(result.unresolvedByRoot['scripts/second.js'].length, 0);
  assert.ok(result.uncertainFiles.some(item => item.file === 'scripts/plugins/known.js' && item.affectedRoots.includes('scripts/first.js')));
  assert.ok(!result.definiteUnreachable.includes('scripts/plugins/known.js'));
  assert.ok(result.definiteUnreachable.includes('scripts/other/unused.js'), 'unrelated folders remain definite inventory rather than inheriting another root\'s uncertainty');
});

test('keeps unresolved computed properties uncertain rather than attributing arbitrary owners', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'const key = getRuntimeKey(); service[key]();'
  });
  assert.ok(result.uncertainty.some(item => item.kind === 'unresolved-computed-property'));
  assert.ok(result.uncertainty.some(item => item.affectedRoots.includes('scripts/main.js')));
});

test('does not claim unreachable files are deletion candidates', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'module.exports = true;',
    'scripts/unreferenced.js': 'module.exports = false;'
  });
  assert.ok(result.definiteUnreachable.includes('scripts/unreferenced.js'));
  // The field is explicitly an inventory only; unresolved behavior never
  // changes this into a deletion recommendation.
  assert.ok(!Object.keys(result).some(key => /deleteCandidates/i.test(key)));
});


test('reports uncertainty observations grouped by kind, affected root, and source file', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('./plugins/' + process.env.PLUGIN); const key = getKey(); service[key]();",
    'scripts/plugins/known.js': 'module.exports = true;'
  });
  const kindTotal = Object.values(result.uncertaintySummary.byKind).reduce((sum, count) => sum + count, 0);
  assert.equal(kindTotal, result.uncertainty.length);
  assert.ok(result.uncertaintySummary.byKind['dynamic-import'] >= 1);
  assert.ok(result.uncertaintySummary.byKind['unresolved-computed-property'] >= 1);
  assert.ok(result.uncertaintySummary.byAffectedRoot['scripts/main.js']);
  assert.ok(result.uncertaintySummary.topFiles.some(item => item.file === 'scripts/main.js'));
  assert.ok(result.uncertaintySummary.computedPropertyRoles.call >= 1);
  assert.ok(result.uncertaintySummary.topComputedPropertyKeys.some(item => item.expression === 'key'));
  assert.equal(result.uncertaintySummary.computedPropertyCallSites.length, 1);
  assert.ok(result.uncertaintySummary.unresolvedLoaderSites.some(item =>
    item.kind === 'dynamic-import' && item.affectedRoots.includes('scripts/main.js')
  ));
});



test('classifies computed properties that flow into indirect calls, constructors, and callbacks', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "const handler = registry[getHandlerKey()]; const alias = handler; alias(); const Constructor = constructors[getConstructorKey()]; new Constructor(); const callback = callbacks[getCallbackKey()]; setTimeout(callback, 1);"
  });
  const roles = result.uncertainty.filter(item => item.kind === 'unresolved-computed-property').map(item => item.accessRole);
  assert.ok(roles.includes('indirect-call'), JSON.stringify(roles));
  assert.ok(roles.includes('indirect-construct'), JSON.stringify(roles));
  assert.ok(roles.includes('indirect-callback'), JSON.stringify(roles));
  assert.equal(result.uncertaintySummary.computedPropertyCallSites.length, 3);
});

test('resolves importScripts loop targets from a constant array', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "const files = ['./one.js', './two.js']; for (const file of files) { importScripts(file); }",
    'scripts/one.js': 'self.one = true;',
    'scripts/two.js': 'self.two = true;'
  });
  assert.ok(edge(result, 'importScripts', 'scripts/main.js', 'scripts/one.js'));
  assert.ok(edge(result, 'importScripts', 'scripts/main.js', 'scripts/two.js'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'importScripts').length, 0);
});


test('function array summaries exclude nested returns and reject mixed dynamic return paths', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "function contentFiles(flag) { function unrelated() { return ['not-injected.js']; } if (flag) return ['one.js']; return ['two.js']; } chrome.scripting.executeScript({ target: { tabId: 1 }, files: contentFiles(true) }); function uncertainFiles(flag) { if (flag) return ['known.js']; return getRuntimeFiles(); } chrome.scripting.executeScript({ target: { tabId: 1 }, files: uncertainFiles(true) });",
    'extension/one.js': 'globalThis.one = true;',
    'extension/two.js': 'globalThis.two = true;',
    'extension/not-injected.js': 'globalThis.unrelated = true;',
    'extension/known.js': 'globalThis.known = true;'
  });
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'scripts/main.js', 'extension/one.js'));
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'scripts/main.js', 'extension/two.js'));
  assert.ok(!edge(result, 'chrome.scripting.executeScript.files', 'scripts/main.js', 'extension/not-injected.js'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'chrome.scripting.executeScript.files').length, 1);
  assert.ok(!result.functionArraySummaries.some(item => item.name === 'uncertainFiles'));
});


test('resolves aliased chrome.scripting loader namespaces and preserves dynamic targets', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'module.exports = true;',
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }),
    'extension/background.js': [
      'const scripting = chrome.scripting;',
      'const scriptingAlias = scripting;',
      "scriptingAlias.executeScript({ target: { tabId: 1 }, files: ['scripts/injected.js'] });",
      "scripting.registerContentScripts([{ id: 'late', js: [{ file: 'scripts/registered.js' }] }]);",
      'const lateOptions = getRuntimeRegistrationOptions();',
      'scriptingAlias.registerContentScripts(lateOptions);'
    ].join(' '),
    'extension/scripts/injected.js': 'globalThis.injected = true;',
    'extension/scripts/registered.js': 'globalThis.registered = true;',
    'extension/scripts/late.js': 'globalThis.late = true;'
  });
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'extension/background.js', 'extension/scripts/injected.js'));
  assert.ok(edge(result, 'chrome.scripting.registerContentScripts', 'extension/background.js', 'extension/scripts/registered.js'));
  const unresolved = result.uncertainty.filter(item => item.kind === 'chrome.scripting.registerContentScripts');
  assert.equal(unresolved.length, 1);
  assert.ok(unresolved[0].affectedRoots.includes('extension/background.js'));
  assert.ok(result.uncertainFiles.some(item =>
    item.file === 'extension/scripts/late.js' &&
    item.affectedRoots.includes('extension/background.js')
  ));
});


test('resolves destructured and directly aliased chrome.scripting loader methods', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'module.exports = true;',
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }),
    'extension/background.js': [
      'const { executeScript: inject, registerContentScripts: register } = chrome.scripting;',
      "inject({ target: { tabId: 1 }, files: ['scripts/destructured.js'] });",
      "const registerAlias = chrome.scripting.registerContentScripts;",
      "registerAlias([{ id: 'alias', js: [{ file: 'scripts/aliased.js' }] }]);"
    ].join(' '),
    'extension/scripts/destructured.js': 'globalThis.destructured = true;',
    'extension/scripts/aliased.js': 'globalThis.aliased = true;'
  });
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'extension/background.js', 'extension/scripts/destructured.js'));
  assert.ok(edge(result, 'chrome.scripting.registerContentScripts', 'extension/background.js', 'extension/scripts/aliased.js'));
});


test('resolves Worker and SharedWorker entrypoints, including constructor aliases and URL literals', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "new Worker('./worker.js');",
      "const WorkerAlias = Worker; new WorkerAlias(new URL('./module-worker.js', import.meta.url), { type: 'module' });",
      "new SharedWorker('./shared-worker.js');"
    ].join(' '),
    'scripts/worker.js': 'self.onmessage = () => {};',
    'scripts/module-worker.js': 'importScripts("./worker-dependency.js");',
    'scripts/shared-worker.js': 'onconnect = () => {};',
    'scripts/worker-dependency.js': 'self.dependency = true;'
  });
  assert.ok(edge(result, 'worker-constructor', 'scripts/main.js', 'scripts/worker.js'));
  assert.ok(edge(result, 'worker-constructor', 'scripts/main.js', 'scripts/module-worker.js'));
  assert.ok(edge(result, 'worker-constructor', 'scripts/main.js', 'scripts/shared-worker.js'));
  assert.ok(edge(result, 'importScripts', 'scripts/module-worker.js', 'scripts/worker-dependency.js'));
});

test('tracks DOM script injection through aliased document and createElement bindings', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const doc = document;',
      'const create = doc.createElement;',
      "const script = create('script');",
      "script.src = './injected.js';",
      'const alias = script;',
      "alias.setAttribute('src', './also-injected.js');",
      'const append = doc.head.appendChild;',
      'append(alias);'
    ].join(' '),
    'extension/injected.js': 'globalThis.injected = true;',
    'extension/also-injected.js': 'globalThis.alsoInjected = true;'
  });
  assert.ok(edge(result, 'dom-script-src-injection', 'scripts/main.js', 'extension/injected.js'));
  assert.ok(edge(result, 'dom-script-setAttribute-injection', 'scripts/main.js', 'extension/also-injected.js'));
  assert.ok(result.dynamicSites.some(item => item.kind === 'dom-script-append' && item.expression === 'alias'));
});


test('tracks message-driven worker script loading as scoped uncertainty', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "const WorkerAlias = Worker; const worker = new WorkerAlias('./message-worker.js'); worker.postMessage('./plugins/runtime.js');",
    'scripts/message-worker.js': 'self.onmessage = event => importScripts(event.data);',
    'scripts/plugins/runtime.js': 'self.runtime = true;'
  });
  assert.ok(edge(result, 'worker-constructor', 'scripts/main.js', 'scripts/message-worker.js'));
  const dynamic = result.uncertainty.find(item =>
    item.file === 'scripts/message-worker.js' && item.kind === 'importScripts'
  );
  assert.ok(dynamic);
  assert.ok(dynamic.affectedRoots.includes('scripts/main.js'));
  assert.ok(result.uncertainFiles.some(item =>
    item.file === 'scripts/plugins/runtime.js' && item.affectedRoots.includes('scripts/main.js')
  ));
});

test('keeps unresolved worker URLs explicitly uncertain within the creating root', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "const path = getWorkerPath(); new Worker(path);",
    'scripts/plugins/runtime-worker.js': 'self.runtime = true;'
  });
  assert.ok(result.uncertainty.some(item =>
    item.kind === 'worker-constructor' && item.affectedRoots.includes('scripts/main.js')
  ));
  assert.ok(result.uncertainFiles.some(item =>
    item.file === 'scripts/plugins/runtime-worker.js' && item.affectedRoots.includes('scripts/main.js')
  ));
});


test('keeps registration options passed through a cross-module wrapper explicitly uncertain', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }),
    'extension/background.js': "import { install } from './registration.js'; install(buildEntries());",
    'extension/registration.js': "export function install(entries) { chrome.scripting.registerContentScripts(entries); }",
    'extension/scripts/runtime.js': 'globalThis.runtime = true;'
  });
  const unknown = result.uncertainty.find(item =>
    item.file === 'extension/registration.js' && item.kind === 'chrome.scripting.registerContentScripts'
  );
  assert.ok(unknown);
  assert.ok(unknown.affectedRoots.includes('extension/background.js'));
  assert.ok(result.uncertainFiles.some(item =>
    item.file === 'extension/scripts/runtime.js' && item.affectedRoots.includes('extension/background.js')
  ));
  assert.ok(!edge(result, 'chrome.scripting.registerContentScripts', 'extension/registration.js', 'extension/scripts/runtime.js'));
});

test('resolves callback ownership through a two-module forwarding chain and re-export barrel', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/registrar.js': 'export function attach(handler) { chrome.runtime.onMessage.addListener(handler); }',
    'scripts/forwarder.js': "import { attach } from './registrar.js'; export function forward(callback) { attach(callback); }",
    'scripts/barrel.js': "export { forward as register } from './forwarder.js';",
    'scripts/main.js': "import { register } from './barrel.js'; function onMessage(message) { return message; } register(onMessage);"
  });
  const registration = result.dynamicSites.find(item =>
    item.file === 'scripts/registrar.js' && item.kind === 'external-callback-registration'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-interprocedural-callback-argument');
  assert.match(registration.callbackTarget, /::onMessage@1:/);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('does not treat executeScript inline func bodies as unresolved file targets', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => document.title });"
  });
  assert.ok(result.dynamicSites.some(item => item.kind === 'chrome.scripting.executeScript.func'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'chrome.scripting.executeScript').length, 0);
});


test('resolves executeScript file lists returned by bounded helper functions', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "function contentFiles() { return ['one.js', 'two.js']; } chrome.scripting.executeScript({ target: { tabId: 1 }, files: contentFiles() });",
    'extension/one.js': 'globalThis.one = true;',
    'extension/two.js': 'globalThis.two = true;'
  });
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'scripts/main.js', 'extension/one.js'),
    JSON.stringify({ functionArraySummaries: result.functionArraySummaries.filter(item => item.file === 'scripts/main.js'), uncertainty: result.uncertainty, injectionSites: result.dynamicSites.filter(item => item.kind.includes('executeScript')) }));
  assert.ok(edge(result, 'chrome.scripting.executeScript.files', 'scripts/main.js', 'extension/two.js'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'chrome.scripting.executeScript').length, 0);
  assert.equal(result.uncertainty.filter(item => item.kind === 'chrome.scripting.executeScript.files').length, 0);
});


test('resolves registered content-script files through aliases and bounded helper arrays', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'module.exports = true;',
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }),
    'extension/background.js': "function registeredFiles() { return ['scripts/first.js', 'scripts/second.js']; } const firstList = registeredFiles(); const aliasList = firstList; chrome.scripting.registerContentScripts([{ id: 'late', js: aliasList }]);",
    'extension/scripts/first.js': 'globalThis.first = true;',
    'extension/scripts/second.js': 'globalThis.second = true;'
  });
  assert.ok(edge(result, 'chrome.scripting.registerContentScripts', 'extension/background.js', 'extension/scripts/first.js'));
  assert.ok(edge(result, 'chrome.scripting.registerContentScripts', 'extension/background.js', 'extension/scripts/second.js'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'chrome.scripting.registerContentScripts').length, 0);
});

test('keeps indirect registered-content-script options explicitly uncertain', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'module.exports = true;',
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }),
    'extension/background.js': [
      "function buildRegistrations() { return [{ id: 'late', matches: ['https://example.com/*'], js: ['scripts/late.js'] }]; }",
      'const registrations = buildRegistrations();',
      'chrome.scripting.registerContentScripts(registrations);',
      'chrome.scripting.registerContentScripts(buildRegistrations());',
      'chrome.scripting.registerContentScripts([{ ...getRegistrationOptions() }]);'
    ].join(' '),
    'extension/scripts/late.js': 'globalThis.late = true;'
  });
  const unknown = result.uncertainty.filter(item => item.kind === 'chrome.scripting.registerContentScripts');
  assert.equal(unknown.length, 3, JSON.stringify(unknown));
  assert.ok(unknown.every(item => item.file === 'extension/background.js'));
  assert.ok(unknown.every(item => item.affectedRoots.includes('extension/background.js')));
  assert.ok(result.uncertainFiles.some(item =>
    item.file === 'extension/scripts/late.js' &&
    item.affectedRoots.includes('extension/background.js')
  ));
});



test('tracks dynamic execution boundaries as scoped uncertainty', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "eval(sourceText);",
      "const Generated = Function('return function generated() {}')();",
      "setTimeout('runPlugin()', 10);",
      "const vm = require('node:vm'); vm.runInNewContext(sourceText, sandbox);"
    ].join(' '),
    'scripts/plugin.js': 'module.exports = true;'
  });
  const boundaries = result.uncertainty.filter(item =>
    ['unresolved-dynamic-execution', 'string-timer-execution'].includes(item.kind)
  );
  assert.ok(boundaries.some(item => item.executionBoundary === 'direct-eval'));
  assert.ok(boundaries.some(item => item.executionBoundary === 'function-constructor'));
  assert.ok(boundaries.some(item => item.executionBoundary === 'string-timer'));
  assert.ok(boundaries.some(item => item.executionBoundary === 'node-vm'));
  assert.ok(boundaries.every(item => item.affectedRoots.includes('scripts/main.js')));
});

test('records framework callback ownership and resolves named and inline callbacks', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) { return message; }',
      'chrome.runtime.onMessage.addListener(onMessage);',
      'document.addEventListener("click", event => event.preventDefault());',
      'Promise.resolve().then(onMessage);'
    ].join(' ')
  });
  const registrations = result.dynamicSites.filter(item => item.kind === 'external-callback-registration');
  assert.equal(registrations.length, 3);
  assert.ok(registrations.some(item => item.callback === 'onMessage' && item.certainty === 'resolved-function-binding'));
  assert.ok(registrations.some(item => item.callback === '[inline callback]' && item.certainty === 'resolved-inline-callback'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('keeps unresolved callback ownership explicit instead of silently assuming a callback target', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'eventBus.on("message", registry[getCallbackKey()]);'
  });
  assert.ok(result.uncertainty.some(item =>
    item.kind === 'unresolved-external-callback-owner' &&
    item.registrationApi.includes('eventBus.on')
  ));
});


test('tracks aliased global eval, reassigned Function constructors, and imported or destructured Node vm execution', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const evaluate = globalThis.eval; evaluate(sourceText);',
      'let compile; compile = Function; compile(\"return 1\")();',
      "const { runInNewContext: runVm } = require('node:vm'); runVm(sourceText, sandbox);",
      "import { Script as VmScript } from 'node:vm'; new VmScript(sourceText);",
      "window.setTimeout('runGenerated()', 1)"
    ].join(' ')
  });
  const boundaries = result.uncertainty.filter(item =>
    ['unresolved-dynamic-execution', 'string-timer-execution'].includes(item.kind)
  );
  assert.ok(boundaries.some(item => item.executionBoundary === 'aliased-eval'));
  assert.ok(boundaries.some(item => item.executionBoundary === 'function-constructor'));
  assert.ok(boundaries.some(item => item.executionBoundary === 'node-vm'));
  assert.ok(boundaries.some(item => item.executionBoundary === 'string-timer'));
});

test('records observer constructors, event-property handlers, and browser API callback ownership', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onResize(entries) { return entries.length; }',
      'const observer = new ResizeObserver(onResize);',
      'window.onmessage = event => event.data;',
      'function onTabs(tabs) { return tabs.length; }',
      'chrome.tabs.query({}, onTabs);'
    ].join(' ')
  });
  const registrations = result.dynamicSites.filter(item => item.kind === 'external-callback-registration');
  assert.ok(registrations.some(item => item.expression === 'ResizeObserver' && item.certainty === 'resolved-function-binding'));
  assert.ok(registrations.some(item => item.expression === 'window.onmessage' && item.certainty === 'resolved-inline-callback'));
  assert.ok(registrations.some(item => item.expression === 'chrome.tabs.query' && item.certainty === 'resolved-function-binding'));
});


test('resolves delegated event handlers, both Promise handlers, and React hook callbacks', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function handleClick(event) { return event.type; }',
      'function onFulfilled(value) { return value; }',
      'function onRejected(error) { throw error; }',
      "jQuery(document).on('click', '.button', handleClick);",
      'Promise.resolve().then(onFulfilled, onRejected);',
      'useEffect(() => { initialize(); }, []);'
    ].join(' ')
  });
  const registrations = result.dynamicSites.filter(item => item.kind === 'external-callback-registration');
  assert.ok(registrations.some(item => item.callback === 'handleClick' && item.certainty === 'resolved-function-binding'));
  assert.ok(registrations.some(item => item.callback === 'onFulfilled' && item.certainty === 'resolved-function-binding'));
  assert.ok(registrations.some(item => item.callback === 'onRejected' && item.certainty === 'resolved-function-binding'));
  assert.ok(registrations.some(item => item.certainty === 'resolved-inline-callback'));
});


test('reports Node module compilation and WebAssembly execution as dynamic-code boundaries', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "module._compile(sourceText, filename);",
      "WebAssembly.compile(binaryBytes);",
      "new WebAssembly.Module(binaryBytes);"
    ].join(' ')
  });
  const boundaries = result.uncertainty.map(item => item.executionBoundary);
  assert.ok(boundaries.includes('node-module-compile'));
  assert.ok(boundaries.includes('wasm-module-execution'));
});


test('tracks aliased and destructured string timer execution', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const delay = window.setTimeout; delay(\"runGenerated()\", 1);',
      'const { setInterval: repeat } = globalThis; repeat(\"runGenerated()\", 1);'
    ].join(' ')
  });
  assert.ok(result.uncertainty.filter(item => item.executionBoundary === 'string-timer').length >= 2);
});


test('detects Node vm execution when required inline rather than bound to a namespace', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "require('vm').runInThisContext(sourceText); new (require('node:vm').Script)(sourceText);"
  });
  assert.ok(result.uncertainty.some(item => item.executionBoundary === 'node-vm'));
});

test('tracks Proxy and Reflect aliases as root-scoped metaprogramming uncertainty', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const makeProxy = Proxy;',
      'const reflection = Reflect;',
      'const proxy = new makeProxy(target, { get(object, key) { return object[key]; }, ownKeys(object) { return Reflect.ownKeys(object); } });',
      'reflection.get(proxy, runtimeKey);',
      'reflection.set(proxy, runtimeKey, handler);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  assert.ok(result.uncertainty.some(item => item.kind === 'proxy-construction'));
  assert.ok(result.uncertainty.some(item => item.kind === 'reflective-property-operation'));
  for (const item of result.uncertainty.filter(item =>
    ['proxy-construction', 'reflective-property-operation'].includes(item.kind))) {
    assert.deepEqual(item.affectedRoots, ['scripts/main.js']);
  }
});

test('reports reflective property enumeration and prototype/descriptor mutation APIs', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const objectApi = Object;',
      'objectApi.getOwnPropertyDescriptors(target);',
      'objectApi.getOwnPropertyDescriptor(target, runtimeKey);',
      'objectApi.getPrototypeOf(target);',
      'objectApi.hasOwn(target, runtimeKey);',
      'Reflect.getPrototypeOf(target);',
      'objectApi.defineProperty(target, runtimeKey, descriptor);',
      'Reflect.setPrototypeOf(target, proto);',
      'target.__proto__ = proto;',
      'Widget.prototype.run = handler;'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  assert.ok(result.uncertainty.some(item => item.kind === 'reflective-property-enumeration'));
  assert.ok(result.uncertainty.some(item => item.kind === 'prototype-or-descriptor-mutation'));
  assert.ok(result.uncertainty.some(item => item.kind === 'prototype-property-mutation'));
});

test('does not misclassify shadowed Proxy, Reflect, or Object bindings as global metaprogramming APIs', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function ordinary(Proxy, Reflect, Object) {',
      '  new Proxy(target, handler);',
      '  Reflect.get(target, key);',
      '  Object.defineProperty(target, key, descriptor);',
      '}',
      'ordinary(localProxy, localReflect, localObject);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.uncertainty.filter(item =>
    ['proxy-construction', 'reflective-property-operation', 'prototype-or-descriptor-mutation'].includes(item.kind)).length, 0);
});

test('tracks destructured and direct aliases of Reflect and Object methods plus Proxy.revocable', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const { get: read, set: write, ownKeys: keys } = Reflect;',
      'const define = Object.defineProperty;',
      'const { getOwnPropertyDescriptors: descriptors } = Object;',
      'const revokeFactory = Proxy.revocable;',
      'read(target, runtimeKey);',
      'write(target, runtimeKey, value);',
      'keys(target);',
      'define(target, runtimeKey, descriptor);',
      'descriptors(target);',
      'revokeFactory(target, handler);',
      'const globalRead = globalThis.Reflect.get;',
      'globalRead(target, runtimeKey);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  const kinds = result.uncertainty.map(item => item.kind);
  assert.ok(kinds.includes('reflective-property-operation'));
  assert.ok(kinds.includes('reflective-property-enumeration'));
  assert.ok(kinds.includes('prototype-or-descriptor-mutation'));
  assert.ok(kinds.includes('proxy-construction'));
  assert.ok(result.uncertainty.every(item => item.affectedRoots.includes('scripts/main.js')));
});

test('does not treat shadowed reflection namespaces as global APIs when destructured', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function ordinary(Reflect, Object) {',
      '  const { get } = Reflect;',
      '  const { defineProperty } = Object;',
      '  get(target, key);',
      '  defineProperty(target, key, descriptor);',
      '}',
      'ordinary(localReflect, localObject);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.uncertainty.filter(item =>
    ['reflective-property-operation', 'reflective-property-enumeration', 'prototype-or-descriptor-mutation'].includes(item.kind)).length, 0);
});

test('propagates chained reflection-method and revocable-proxy aliases', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const reflection = Reflect;',
      'const firstRead = reflection.get;',
      'const read = firstRead;',
      'const objectApi = Object;',
      'const firstDefine = objectApi.defineProperty;',
      'const define = firstDefine;',
      'const revocable = Proxy.revocable;',
      'const createRevocable = revocable;',
      'read(target, key);',
      'define(target, key, descriptor);',
      'createRevocable(target, handler);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  const kinds = result.uncertainty.map(item => item.kind);
  assert.ok(kinds.includes('reflective-property-operation'));
  assert.ok(kinds.includes('prototype-or-descriptor-mutation'));
  assert.ok(kinds.includes('proxy-construction'));
  assert.ok(result.uncertainty.every(item => item.affectedRoots.includes('scripts/main.js')));
});

test('tracks destructured Proxy.revocable aliases without misclassifying shadowed Proxy', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const { revocable: createRevocable } = Proxy;',
      'createRevocable(target, handler);',
      'function local(Proxy) { const { revocable } = Proxy; revocable(target, handler); }'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  const proxies = result.uncertainty.filter(item => item.kind === 'proxy-construction');
  assert.equal(proxies.length, 1);
  assert.deepEqual(proxies[0].affectedRoots, ['scripts/main.js']);
});

test('tracks assignment-based aliases of reflection APIs and Proxy constructors', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'let reflection;',
      'reflection = Reflect;',
      'let read;',
      'read = reflection.get;',
      'let objectApi;',
      'objectApi = Object;',
      'let define;',
      'define = objectApi.defineProperty;',
      'let createProxy;',
      'createProxy = Proxy;',
      'new createProxy(target, handler);',
      'read(target, runtimeKey);',
      'define(target, runtimeKey, descriptor);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  const kinds = result.uncertainty.map(item => item.kind);
  assert.ok(kinds.includes('proxy-construction'));
  assert.ok(kinds.includes('reflective-property-operation'));
  assert.ok(kinds.includes('prototype-or-descriptor-mutation'));
  assert.ok(result.uncertainty.every(item => item.affectedRoots.includes('scripts/main.js')));
});

test('does not promote aliases copied from locally shadowed Proxy, Reflect, or Object parameters', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function ordinary(Proxy, Reflect, Object) {',
      '  const makeProxy = Proxy;',
      '  const reflection = Reflect;',
      '  const objectApi = Object;',
      '  new makeProxy(target, handler);',
      '  reflection.get(target, key);',
      '  objectApi.defineProperty(target, key, descriptor);',
      '}',
      'ordinary(localProxy, localReflect, localObject);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.uncertainty.filter(item =>
    ['proxy-construction', 'reflective-property-operation', 'prototype-or-descriptor-mutation'].includes(item.kind)).length, 0);
});
