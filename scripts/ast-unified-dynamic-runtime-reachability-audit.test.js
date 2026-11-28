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
    '.github/workflows/ci.yml': "jobs:\n  checks:\n    steps:\n      - run: node --test scripts/ci-check.test.js\n      - run: node --test tests/selector/*.test.mjs\n      - run: node regression-suite/tests/run-regression.mjs extension\n      - run: for test_file in scripts/test-*.js; do node \"$test_file\"; done",
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


test('discovers nested composite-action Node commands as execution roots', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { test: 'playwright test' } }),
    '.github/actions/audit/action.yml': [
      'name: Audit action',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - shell: bash',
      '      run: node scripts/action-audit.js'
    ].join('\n'),
    '.github/actions/nested/verify/action.yaml': [
      'name: Nested verify action',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - shell: bash',
      '      run: node scripts/action-verify.mjs'
    ].join('\n'),
    'scripts/action-audit.js': "const helper = require('./action-helper.js'); helper.run();",
    'scripts/action-helper.js': 'exports.run = () => true;',
    'scripts/action-verify.mjs': 'export const verified = true;'
  });
  assert.ok(result.roots.includes('scripts/action-audit.js'));
  assert.ok(result.roots.includes('scripts/action-verify.mjs'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/action-audit.js', 'scripts/action-helper.js'));
});

test('discovers direct Node entrypoints outside conventional script folders and after shell separators', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'echo begin; node tools/package-audit.js' } }),
    '.github/workflows/tools.yml': [
      'jobs:',
      '  check:',
      '    steps:',
      '      - working-directory: tools',
      '        run: node --test workflow-audit.test.mjs'
    ].join('\n'),
    '.github/actions/tools/action.yml': [
      'name: Tools action',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - shell: bash',
      '      run: node ./tools/action-audit.js'
    ].join('\n'),
    'tools/package-audit.js': "require('./shared.js');",
    'tools/shared.js': 'module.exports = true;',
    'tools/workflow-audit.test.mjs': 'export const workflowTest = true;',
    'tools/action-audit.js': 'export const actionAudit = true;'
  });
  assert.ok(result.roots.includes('tools/package-audit.js'));
  assert.ok(result.roots.includes('tools/workflow-audit.test.mjs'));
  assert.ok(result.roots.includes('tools/action-audit.js'));
  assert.ok(edge(result, 'commonjs-require', 'tools/package-audit.js', 'tools/shared.js'));
});

test('expands question-mark workflow Node entrypoint globs', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { test: 'playwright test' } }),
    '.github/workflows/ci.yml': 'steps:\n  - run: node --test scripts/check?.test.mjs\n',
    'scripts/check1.test.mjs': 'export const one = true;',
    'scripts/check2.test.mjs': 'export const two = true;',
    'scripts/check-extra.test.mjs': 'export const extra = true;'
  });
  assert.ok(result.roots.includes('scripts/check1.test.mjs'));
  assert.ok(result.roots.includes('scripts/check2.test.mjs'));
  assert.equal(result.roots.includes('scripts/check-extra.test.mjs'), false);
});

test('expands package-script Node test globs into unified execution roots', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { test: 'node --test scripts/*.test.js' } }),
    'scripts/alpha.test.js': "require('./helper.js');",
    'scripts/beta.test.js': 'module.exports = true;',
    'scripts/helper.js': 'module.exports = true;'
  });
  assert.ok(result.roots.includes('scripts/alpha.test.js'));
  assert.ok(result.roots.includes('scripts/beta.test.js'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/alpha.test.js', 'scripts/helper.js'));
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

test('covers Chrome and browser callback APIs beyond the common method-name allowlist', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onBookmarkTree(nodes) { return nodes.length; }',
      'function onToken(token) { return token; }',
      'function onMessage(response) { return response; }',
      'chrome.bookmarks.getTree(onBookmarkTree);',
      'chrome.identity.getAuthToken({ interactive: false }, onToken);',
      'browser.runtime.sendMessage({ type: "ping" }, onMessage);'
    ].join(' ')
  });
  const registrations = result.dynamicSites.filter(item => item.kind === 'external-callback-registration');
  for (const [expression, callback] of [
    ['chrome.bookmarks.getTree', 'onBookmarkTree'],
    ['chrome.identity.getAuthToken', 'onToken'],
    ['browser.runtime.sendMessage', 'onMessage']
  ]) {
    assert.ok(registrations.some(item =>
      item.expression === expression && item.callback === callback &&
      item.certainty === 'resolved-function-binding'),
    'expected callback ownership for ' + expression);
  }
});

test('traces aliased and destructured extension API callback roots', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onTabs(tabs) { return tabs.length; }',
      'function onTree(nodes) { return nodes.length; }',
      'const queryTabs = chrome.tabs.query;',
      'queryTabs({}, onTabs);',
      'const tabs = chrome.tabs;',
      'tabs.query({}, onTabs);',
      'const { getTree } = chrome.bookmarks;',
      'getTree(onTree);'
    ].join(' ')
  });
  const registrations = result.dynamicSites.filter(item => item.kind === 'external-callback-registration');
  assert.ok(registrations.some(item =>
    item.expression === 'chrome.tabs.query' && item.callback === 'onTabs' &&
    item.certainty === 'resolved-function-binding'));
  assert.ok(registrations.some(item =>
    item.expression === 'chrome.bookmarks.getTree' && item.callback === 'onTree' &&
    item.certainty === 'resolved-function-binding'));
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


test('traces aliased observer constructors and object-based event listener handlers', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onResize(entries) { return entries.length; }',
      'const BaseObserver = ResizeObserver;',
      'const Observer = BaseObserver;',
      'new Observer(onResize);',
      'document.addEventListener("click", { handleEvent(event) { return event.type; } });',
      'document.addEventListener("keydown", { handleEvent: function(event) { return event.key; } });'
    ].join(' ')
  });
  const registrations = result.dynamicSites.filter(item => item.kind === 'external-callback-registration');
  assert.ok(registrations.some(item =>
    item.expression === 'Observer' && item.callback === 'onResize' &&
    item.certainty === 'resolved-function-binding'));
  assert.equal(registrations.filter(item =>
    item.certainty === 'resolved-object-event-handler').length, 2);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('resolves named and helper-passed object event listener handlers', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const namedListener = { handleEvent(event) { return event.type; } };',
      'document.addEventListener("click", namedListener);',
      'const delegatedListener = { handleEvent(event) { return event.key; } };',
      'function installListener(listener) { document.addEventListener("keydown", listener); }',
      'installListener(delegatedListener);'
    ].join(' ')
  });
  const registrations = result.dynamicSites.filter(item => item.kind === 'external-callback-registration');
  assert.equal(registrations.filter(item =>
    item.certainty === 'resolved-object-event-handler-binding').length, 2);
  assert.ok(registrations.every(item => item.callbackTarget?.includes('function@')));
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('resolves bound handleEvent method callbacks without losing their object owner', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const boundListener = { handleEvent(event) { return event.type; } };',
      'document.addEventListener("click", boundListener.handleEvent.bind(boundListener));'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' && item.expression === 'document.addEventListener');
  assert.ok(registration);
  assert.equal(registration.callback, '[bound handleEvent listener]');
  assert.equal(registration.certainty, 'resolved-bound-object-event-handler');
  assert.ok(registration.callbackTarget?.includes('function@'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('keeps bound handleEvent callbacks unresolved when their listener object is reassigned', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'let listener = { handleEvent(event) { return event.type; } };',
      'listener = replacement;',
      'document.addEventListener("click", listener.handleEvent.bind(listener));'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' && item.expression === 'document.addEventListener');
  assert.ok(registration);
  assert.notEqual(registration.certainty, 'resolved-bound-object-event-handler');
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 1);
});

test('keeps helper listener parameters unresolved when callers disagree', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const knownListener = { handleEvent(event) { return event.type; } };',
      'function installListener(listener) { document.addEventListener("click", listener); }',
      'installListener(knownListener);',
      'installListener(runtimeValue);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' && item.expression === 'document.addEventListener');
  assert.ok(registration);
  assert.notEqual(registration.certainty, 'resolved-object-event-handler-binding');
  assert.equal(registration.certainty, 'unresolved-callback-owner');
});

test('keeps reassigned named listener objects unresolved', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'let listener = { handleEvent(event) { return event.type; } };',
      'listener = replacement;',
      'document.addEventListener("click", listener);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' && item.expression === 'document.addEventListener');
  assert.ok(registration);
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 1);
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

test('tracks namespace aliases through qualified globalThis, window, and self references', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const reflection = globalThis.Reflect;',
      'const objectApi = window.Object;',
      'const anotherReflection = self.Reflect;',
      'reflection.get(target, key);',
      'objectApi.defineProperty(target, key, descriptor);',
      'objectApi.keys(target);',
      'anotherReflection.ownKeys(target);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  assert.ok(result.uncertainty.some(item => item.kind === 'reflective-property-operation'));
  assert.ok(result.uncertainty.some(item => item.kind === 'reflective-property-enumeration'));
  assert.ok(result.uncertainty.some(item => item.kind === 'prototype-or-descriptor-mutation'));
  assert.ok(result.uncertainty.every(item => item.affectedRoots.includes('scripts/main.js')));
});

test('keeps assignment-based reflection aliases scoped to their lexical bindings', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'let globalReflection;',
      'globalReflection = Reflect;',
      'let globalRead;',
      'globalRead = globalReflection.get;',
      'globalRead(target, runtimeKey);',
      'function local(Reflect, Object, Proxy) {',
      '  let localReflection;',
      '  localReflection = Reflect;',
      '  let localDefine;',
      '  localDefine = Object.defineProperty;',
      '  let localProxy;',
      '  localProxy = Proxy;',
      '  localReflection.get(target, key);',
      '  localDefine(target, key, descriptor);',
      '  new localProxy(target, handler);',
      '}',
      'local(fakeReflect, fakeObject, fakeProxy);'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  const metaSites = result.uncertainty.filter(item =>
    ['proxy-construction', 'reflective-property-operation', 'prototype-or-descriptor-mutation'].includes(item.kind));
  assert.equal(metaSites.length, 1);
  assert.equal(metaSites[0].kind, 'reflective-property-operation');
  assert.deepEqual(metaSites[0].affectedRoots, ['scripts/main.js']);
});


test('reports dynamic computed API names on Reflect, Object, and Proxy namespaces', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const reflection = Reflect;',
      'const objectApi = globalThis.Object;',
      'const proxyApi = self.Proxy;',
      'const methodName = getMethodName();',
      'reflection[methodName](target, key);',
      'objectApi[methodName](target, descriptor);',
      'new proxyApi[methodName](target, handler);',
      'globalThis.Reflect[methodName](target, key);',
      'window.Object[methodName](target, descriptor);',
      'self.Proxy[methodName](target, handler);',
      'function local(Reflect) { Reflect[getMethodName()](target, key); }'
    ].join(' ')
  });
  assert.equal(result.parseErrors.length, 0);
  const dynamicNames = result.uncertainty.filter(item => item.kind === 'dynamic-reflective-api-name');
  assert.equal(dynamicNames.length, 6);
  assert.ok(dynamicNames.every(item => item.affectedRoots.includes('scripts/main.js')));
  assert.ok(dynamicNames.some(item => item.expression.includes('reflection[methodName]')));
  assert.ok(dynamicNames.some(item => item.expression.includes('objectApi[methodName]')));
  assert.ok(dynamicNames.some(item => item.expression.includes('proxyApi[methodName]')));
});


test('resolves callbacks returned by local higher-order factories at external registration sites', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(message) { return message; }',
      'function makeHandler() { return onMessage; }',
      'chrome.runtime.onMessage.addListener(makeHandler());'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' &&
    item.expression === 'chrome.runtime.onMessage.addListener'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-factory-return', JSON.stringify(registration));
  assert.ok(registration.callbackTarget.endsWith('::onMessage@1:9'), registration.callbackTarget);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('resolves callbacks returned by imported factories across module boundaries', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { makeHandler } from './handlers.js';",
      'chrome.runtime.onMessage.addListener(makeHandler());'
    ].join(' '),
    'scripts/handlers.js': [
      'function onMessage(message) { return message; }',
      'export function makeHandler() { return onMessage; }'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' &&
    item.expression === 'chrome.runtime.onMessage.addListener'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-factory-return', JSON.stringify(registration));
  assert.ok(registration.callbackTarget.startsWith('scripts/handlers.js::onMessage@'), registration.callbackTarget);
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('keeps callback factories uncertain when return paths produce different functions', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function first(message) { return message; }',
      'function second(message) { return message; }',
      'function makeHandler(flag) { if (flag) return first; return second; }',
      'chrome.runtime.onMessage.addListener(makeHandler(runtimeFlag));'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' &&
    item.expression === 'chrome.runtime.onMessage.addListener'
  );
  assert.ok(registration);
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 1);
});


test('resolves indirect module.require loading while respecting lexical module shadowing', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "const target = './feature.js';",
      'module.require(target);',
      'function isolated(module) { module.require("./not-a-real-local.js"); }'
    ].join(' '),
    'scripts/feature.js': 'module.exports = true;'
  });
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'scripts/feature.js'));
  assert.equal(result.dynamicSites.some(item =>
    item.kind === 'require' && item.expression === './not-a-real-local.js'
  ), false);
});


test('resolves immutable aliases of require and module.createRequire results', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { createRequire as makeRequire } from 'node:module';",
      "const localRequire = require;",
      "const load = localRequire;",
      "const requireFromHere = makeRequire(import.meta.url);",
      "load('./feature.js');",
      "requireFromHere('./other.js');"
    ].join(' '),
    'scripts/feature.js': 'module.exports = 1;',
    'scripts/other.js': 'module.exports = 2;'
  });
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'scripts/feature.js'));
  assert.ok(edge(result, 'commonjs-createRequire', 'scripts/main.js', 'scripts/other.js'));
});


test('honors package conditional-export key order for active conditions', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      '.': { default: './src/default.js', import: './src/import.js', require: './src/require.js' }
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('fixture-suite'); require('fixture-suite');",
    'src/default.js': 'export const selected = "default";',
    'src/import.js': 'export const selected = "import";',
    'src/require.js': 'module.exports = "require";'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/default.js'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'src/default.js'));
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/import.js'), false);
  assert.equal(edge(result, 'commonjs-require', 'scripts/main.js', 'src/require.js'), false);
});

test('continues to later conditions when a nested active condition has no matching key', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      '.': {
        import: { browser: './src/browser.js' },
        default: './src/fallback.js'
      }
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('fixture-suite');",
    'src/browser.js': 'export const browser = true;',
    'src/fallback.js': 'export const fallback = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/fallback.js'));
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/browser.js'), false);
});

test('does not fall through a selected null package export condition', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      '.': { import: null, default: './src/fallback.js' }
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('fixture-suite');",
    'src/fallback.js': 'export const fallback = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/fallback.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.kind === 'dynamic-import' && item.expression === 'fixture-suite'
  ));
});

test('does not fall through a valid but missing package export array target', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      '.': { import: ['./src/missing.js', './src/fallback.js'], require: './src/require.js' }
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('fixture-suite'); require('fixture-suite');",
    'src/fallback.js': 'export const fallback = true;',
    'src/require.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/fallback.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.kind === 'dynamic-import' && item.expression === 'fixture-suite'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'src/require.js'));
});

test('falls through invalid package export array targets to a later valid target', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      '.': ['../outside.js', './src/fallback.js']
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('fixture-suite');",
    'outside.js': 'export const outside = true;',
    'src/fallback.js': 'export const fallback = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/fallback.js'));
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'outside.js'), false);
});

test('resolves package self-reference exports for import and require conditions', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      '.': { import: './src/esm.js', require: './src/cjs.js' },
      './feature': './src/feature.js'
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import('fixture-suite');",
      "require('fixture-suite');",
      "import('fixture-suite/feature');"
    ].join(' '),
    'src/esm.js': 'export const mode = "esm";',
    'src/cjs.js': 'module.exports = "cjs";',
    'src/feature.js': 'export const feature = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/esm.js'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'src/cjs.js'));
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/feature.js'));
});


test('resolves package self-reference in static imports and re-exports', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      '.': { import: './src/index.js', require: './src/index.cjs' },
      './shared': './src/shared.js'
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import { value } from 'fixture-suite'; export { shared } from 'fixture-suite/shared';",
    'src/index.js': 'export const value = true;',
    'src/index.cjs': 'module.exports = true;',
    'src/shared.js': 'export const shared = true;'
  });
  assert.ok(edge(result, 'static-import', 'scripts/main.js', 'src/index.js'));
  assert.ok(edge(result, 're-export', 'scripts/main.js', 'src/shared.js'));
});

test('records unresolved static package imports as uncertainty rather than dropping them', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import 'dependency-not-present'; export * from 'another-missing-package';"
  });
  assert.equal(result.uncertainty.filter(item => item.certainty === 'unresolved-static-import').length, 2);
  assert.ok(result.uncertainty.some(item => item.expression === 'dependency-not-present'));
  assert.ok(result.uncertainty.some(item => item.expression === 'another-missing-package'));
});

test('recognizes active Node conditions while preserving manifest condition order', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      '.': {
        'node-addons': './src/node-addons.js',
        import: './src/import.js',
        'module-sync': './src/module-sync.js',
        default: './src/default.js'
      }
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('fixture-suite');",
    'src/node-addons.js': 'export const selected = "node-addons";',
    'src/import.js': 'export const selected = "import";',
    'src/module-sync.js': 'export const selected = "module-sync";',
    'src/default.js': 'export const selected = "default";'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/node-addons.js'));
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/import.js'), false);
});

test('rejects percent-encoded package-map traversal and separators', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      './encoded-dot': './src/%2e%2e/outside.js',
      './encoded-separator': './src%2f..%2foutside.js'
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import('fixture-suite/encoded-dot');",
      "import('fixture-suite/encoded-separator');"
    ].join(' '),
    'outside.js': 'export const outside = true;',
    'src/outside.js': 'export const misleading = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'outside.js'), false);
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/outside.js'), false);
  assert.ok(result.uncertainty.some(item => item.expression === 'fixture-suite/encoded-dot'));
  assert.ok(result.uncertainty.some(item => item.expression === 'fixture-suite/encoded-separator'));
});

test('requires exact package-map target paths without extension or directory-index fallback', () => {
  const result = run({
    'package.json': JSON.stringify({
      name: 'app',
      type: 'module',
      exports: { '.': './entry' },
      scripts: { audit: 'node scripts/main.js' }
    }),
    'scripts/main.js': [
      "import 'app';",
      "import './consumer.js';"
    ].join(' '),
    'entry.js': 'module.exports = true;',
    'consumer.js': "import value from 'app';"
  });
  assert.equal(edge(result, 'static-import', 'scripts/main.js', 'entry.js'), false);
  assert.equal(edge(result, 'static-import', 'consumer.js', 'entry.js'), false);
});

test('uses exact-file relative resolution for ESM and extension probing for CommonJS', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import './dependency';",
      "import './folder';",
      "import('./dynamic');",
      "require('./dependency');",
      "require('./folder');"
    ].join(' '),
    'scripts/dependency.js': 'module.exports = true;',
    'scripts/dynamic.js': 'export const value = true;',
    'scripts/folder/index.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'static-import', 'scripts/main.js', 'scripts/dependency.js'), false);
  assert.equal(edge(result, 'static-import', 'scripts/main.js', 'scripts/folder/index.js'), false);
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'scripts/dynamic.js'), false);
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'scripts/dependency.js'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'scripts/folder/index.js'));
});

test('uses Node main rather than the bundler-specific module field for legacy packages', () => {
  const result = run({
    'package.json': JSON.stringify({
      name: 'fixture-suite',
      main: './src/main.js',
      module: './src/module.js',
      scripts: { audit: 'node scripts/main.js' }
    }),
    'scripts/main.js': "import('fixture-suite');",
    'src/main.js': 'module.exports = true;',
    'src/module.js': 'export const wrong = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/main.js'));
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/module.js'), false);
});

test('rejects dot segments and node_modules segments in package-map targets', () => {
  const result = run({
    'package.json': JSON.stringify({
      name: 'app',
      exports: {
        './dot': './features/./entry.js',
        './dependency': './node_modules/dep/index.js'
      },
      scripts: { audit: 'node scripts/main.js' }
    }),
    'scripts/main.js': [
      "require('app/dot');",
      "require('app/dependency');"
    ].join(' '),
    'features/entry.js': 'module.exports = true;',
    'node_modules/dep/index.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'commonjs-require', 'scripts/main.js', 'features/entry.js'), false);
  assert.equal(edge(result, 'commonjs-require', 'scripts/main.js', 'node_modules/dep/index.js'), false);
});

test('rejects encoded package-target separators even when the decoded path is contained', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      './encoded-forward': './src%2fentry.js',
      './encoded-backward': './src%5Centry.js',
      './encoded-dot': './src/%2e/entry.js'
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import('fixture-suite/encoded-forward');",
      "import('fixture-suite/encoded-backward');",
      "import('fixture-suite/encoded-dot');"
    ].join(' '),
    'src/entry.js': 'export const entry = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/entry.js'), false);
  for (const expression of [
    'fixture-suite/encoded-forward',
    'fixture-suite/encoded-backward',
    'fixture-suite/encoded-dot'
  ]) assert.ok(result.uncertainty.some(item => item.expression === expression));
});

test('rejects package export targets that escape the package root', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('../local-package');",
    'local-package/package.json': JSON.stringify({ exports: './..\\/outside.js' }),
    'outside.js': 'export const outside = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'outside.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.kind === 'dynamic-import' && item.expression === '../local-package'
  ));
});

test('resolves CommonJS relative package directories while keeping ESM directory imports unresolved', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import('../local-package');",
      "require('../local-package');",
      "require('../legacy-package');",
      "import('external-dependency');"
    ].join(' '),
    'local-package/package.json': JSON.stringify({
      type: 'module',
      main: './lib/start.cjs',
      exports: { '.': './entry.mjs' }
    }),
    'local-package/entry.mjs': 'export const value = 1;',
    'local-package/lib/start.cjs': 'module.exports = 1;',
    'legacy-package/package.json': JSON.stringify({ main: 'lib/start.js' }),
    'legacy-package/lib/start.js': 'module.exports = 1;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'local-package/entry.mjs'), false);
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'local-package/lib/start.cjs'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'legacy-package/lib/start.js'));
  assert.ok(result.uncertainty.some(item => item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import' && item.expression === 'external-dependency'));
});

test('does not treat a shadowed importScripts function as the worker loader', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function importScripts(specifier) { return specifier; }',
      "importScripts('./not-a-worker-dependency.js');"
    ].join(' '),
    'scripts/not-a-worker-dependency.js': 'export const unrelated = true;'
  });
  assert.equal(edge(result, 'importScripts', 'scripts/main.js', 'scripts/not-a-worker-dependency.js'), false, JSON.stringify({ sites: result.dynamicSites.filter(site => site.kind === 'importScripts'), edges: result.edges.filter(item => item.kind === 'importScripts') }));
  assert.ok(result.dynamicSites.some(site =>
    site.kind === 'importScripts' && site.file === 'scripts/main.js' &&
    site.certainty === 'unresolved-shadowed-importScripts'
  ));
});

test('does not extension-probe ESM package subpaths without an exports map', () => {
  const result = run({
    'package.json': JSON.stringify({
      name: 'fixture-suite',
      scripts: { audit: 'node scripts/main.js' }
    }),
    'scripts/main.js': [
      "import('fixture-suite/feature');",
      "require('fixture-suite/feature');"
    ].join(' '),
    'feature.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'feature.js'), false);
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'feature.js'));
});

test('does not resolve bare external package specifiers as sibling filesystem paths', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('external-dependency'); require('external-dependency');",
    'scripts/external-dependency.js': 'export const misleading = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'scripts/external-dependency.js'), false);
  assert.equal(edge(result, 'commonjs-require', 'scripts/main.js', 'scripts/external-dependency.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.kind === 'dynamic-import' && item.expression === 'external-dependency'
  ));
  assert.ok(result.uncertainty.some(item =>
    item.kind === 'require' && item.expression === 'external-dependency'
  ));
});

test('keeps unknown and package require targets explicitly uncertain', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const load = require;',
      'load(runtimeSpecifier);',
      "load('external-package');"
    ].join(' ')
  });
  assert.ok(result.uncertainty.some(item => item.kind === 'require' && item.certainty === 'unresolved-dynamic-require'));
  assert.ok(result.uncertainty.some(item => item.kind === 'require' && item.certainty === 'unresolved-package-require'));
});

test('resolves package wildcard exports for import and require conditions', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'fixture-suite', exports: {
      './features/*': { import: './src/esm/*.js', require: './src/cjs/*.cjs' }
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import('fixture-suite/features/alpha');",
      "require('fixture-suite/features/beta');"
    ].join(' '),
    'src/esm/alpha.js': 'export const alpha = true;',
    'src/cjs/beta.cjs': 'module.exports = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/esm/alpha.js'));
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'src/cjs/beta.cjs'));
});

test('does not fall through an external package-import target in an array', () => {
  const result = run({
    'package.json': JSON.stringify({ imports: {
      '#internal': ['external-dependency', './src/fallback.js']
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('#internal');",
    'src/fallback.js': 'export const fallback = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/main.js', 'src/fallback.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.kind === 'dynamic-import' && item.expression === '#internal'
  ));
});

test('resolves package imports and self-references from the nearest nested package scope', () => {
  const result = run({
    'package.json': JSON.stringify({ name: 'root-suite', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import('../packages/feature/index.js');",
    'packages/feature/package.json': JSON.stringify({
      name: 'feature-package',
      imports: { '#internal/*': './src/*.js' },
      exports: { '.': './src/self.js' }
    }),
    'packages/feature/index.js': [
      "import('#internal/tool');",
      "import('feature-package');"
    ].join(' '),
    'packages/feature/src/tool.js': 'export const tool = true;',
    'packages/feature/src/self.js': 'export const self = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'packages/feature/index.js', 'packages/feature/src/tool.js'));
  assert.ok(edge(result, 'dynamic-import', 'packages/feature/index.js', 'packages/feature/src/self.js'));
  assert.equal(result.uncertainty.some(item =>
    item.file === 'packages/feature/index.js' && item.expression === '#internal/tool'
  ), false);
});

test('resolves local package imports aliases and keeps unknown aliases uncertain', () => {
  const result = run({
    'package.json': JSON.stringify({ imports: {
      '#internal/*': './src/internal/*.js',
      '#external': 'external-package'
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import('#internal/tools');",
      "import('#missing');",
      "import('#external');"
    ].join(' '),
    'src/internal/tools.js': 'export const tools = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/main.js', 'src/internal/tools.js'));
  assert.ok(result.uncertainty.some(item => item.expression === '#missing' && item.certainty === 'unresolved-dynamic-import'));
  assert.ok(result.uncertainty.some(item => item.expression === '#external' && item.certainty === 'unresolved-dynamic-import'));
});

test('resolves createRequire relative to the module that supplies its import.meta.url base', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': "import './config/loader.js';",
    'scripts/config/loader.js': [
      "import { createRequire } from 'node:module';",
      'const loadFromConfig = createRequire(import.meta.url);',
      "loadFromConfig('./dependency.js');"
    ].join(' '),
    'scripts/config/dependency.js': 'module.exports = true;',
    'scripts/dependency.js': 'module.exports = false;'
  });
  assert.ok(edge(result, 'commonjs-createRequire', 'scripts/config/loader.js', 'scripts/config/dependency.js'));
  assert.equal(edge(result, 'commonjs-createRequire', 'scripts/config/loader.js', 'scripts/dependency.js'), false);
});

test('uses import.meta.url as the createRequire base and propagates base context through aliases', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { createRequire as makeRequire } from 'node:module';",
      'const first = makeRequire(import.meta.url);',
      'const second = first;',
      "second('./dependency.js');"
    ].join(' '),
    'scripts/dependency.js': 'module.exports = true;'
  });
  assert.ok(edge(result, 'commonjs-createRequire', 'scripts/main.js', 'scripts/dependency.js'));
});

test('recognizes CommonJS and namespace forms of the Node createRequire API', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "const direct = require('node:module').createRequire(import.meta.url);",
      "const { createRequire: destructured } = require('module');",
      'const fromDestructured = destructured(import.meta.url);',
      "import * as Module from 'node:module';",
      'const fromNamespace = Module.createRequire(import.meta.url);',
      "const CommonJSModule = require('module');",
      'const fromCommonJSNamespace = CommonJSModule.createRequire(import.meta.url);',
      "direct('./direct.js');",
      "fromDestructured('./destructured.js');",
      "fromNamespace('./namespace.js');",
      "fromCommonJSNamespace('./commonjs-namespace.js');"
    ].join(' '),
    'scripts/direct.js': 'module.exports = true;',
    'scripts/destructured.js': 'module.exports = true;',
    'scripts/namespace.js': 'module.exports = true;',
    'scripts/commonjs-namespace.js': 'module.exports = true;'
  });
  for (const target of ['direct.js', 'destructured.js', 'namespace.js', 'commonjs-namespace.js']) {
    assert.ok(edge(result, 'commonjs-createRequire', 'scripts/main.js', 'scripts/' + target));
  }
});

test('does not treat the nonexistent module.createRequire instance property as Node API', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const load = module.createRequire(import.meta.url);',
      "load('./not-loaded.js');"
    ].join(' '),
    'scripts/not-loaded.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'commonjs-createRequire', 'scripts/main.js', 'scripts/not-loaded.js'), false);
});

test('does not resolve createRequire relative imports when its base is unknown', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { createRequire } from 'node:module';",
      'const load = createRequire(runtimeBase);',
      "load('./maybe.js');"
    ].join(' '),
    'scripts/maybe.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'commonjs-createRequire', 'scripts/main.js', 'scripts/maybe.js'), false);
  assert.ok(result.uncertainty.some(item => item.certainty === 'unresolved-createRequire-base-context'));
});


test('resolves a local loader wrapper only when it directly forwards its sole argument to require', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function loadLocal(specifier) { return require(specifier); }',
      'const loadOther = name => require(name);',
      "loadLocal('./first.js');",
      "loadOther('./second.js');"
    ].join(' '),
    'scripts/first.js': 'module.exports = 1;',
    'scripts/second.js': 'module.exports = 2;'
  });
  assert.ok(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/first.js'));
  assert.ok(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/second.js'));
});

test('resolves createRequire-backed loader wrappers from their factory base', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { createRequire } from 'node:module';",
      'const configRequire = createRequire(import.meta.url);',
      'function loadFromConfig(specifier) { return configRequire(specifier); }',
      "loadFromConfig('./dependency.js');"
    ].join(' '),
    'scripts/dependency.js': 'module.exports = true;'
  });
  assert.ok(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/dependency.js'));
});

test('invalidates unresolved name-based wrapper references after reassignment', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function loadLocal(specifier) { return require(specifier); }',
      'loadLocal = unrelated;',
      "loadLocal('./not-loaded.js');"
    ].join(' '),
    'scripts/not-loaded.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/not-loaded.js'), false);
});

test('keeps wrappers over unknown createRequire bases explicitly unresolved', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { createRequire } from 'node:module';",
      'const configRequire = createRequire(runtimeBase);',
      'function loadFromConfig(specifier) { return configRequire(specifier); }',
      "loadFromConfig('./maybe.js');"
    ].join(' '),
    'scripts/maybe.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/maybe.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.certainty === 'unresolved-createRequire-base-context'));
});

test('does not trust a CommonJS loader wrapper after its binding is reassigned', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function loadLocal(specifier) { return require(specifier); }',
      'loadLocal = unrelated;',
      "loadLocal('./not-loaded.js');"
    ].join(' '),
    'scripts/not-loaded.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/not-loaded.js'), false);
});

test('invalidates reassigned CommonJS loader aliases without invalidating captured aliases', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const originalRequire = require;',
      'let mutableRequire = originalRequire;',
      'mutableRequire = customLoader;',
      "originalRequire('./valid.js');",
      "mutableRequire('./not-loaded.js');"
    ].join(' '),
    'scripts/valid.js': 'module.exports = true;',
    'scripts/not-loaded.js': 'module.exports = true;'
  });
  assert.ok(edge(result, 'commonjs-require', 'scripts/main.js', 'scripts/valid.js'));
  assert.equal(edge(result, 'commonjs-require', 'scripts/main.js', 'scripts/not-loaded.js'), false);
});

test('invalidates reassigned createRequire factories and result aliases', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { createRequire } from 'node:module';",
      'let factory = createRequire;',
      'factory = customFactory;',
      'const invalidRequire = factory(import.meta.url);',
      "invalidRequire('./factory-target.js');",
      'function loadFromInvalidFactory(specifier) { return invalidRequire(specifier); }',
      "loadFromInvalidFactory('./factory-wrapper-target.js');",
      'const validRequire = createRequire(import.meta.url);',
      'let mutableRequire = validRequire;',
      'mutableRequire = customLoader;',
      "validRequire('./valid.js');",
      "mutableRequire('./result-target.js');"
    ].join(' '),
    'scripts/factory-target.js': 'module.exports = true;',
    'scripts/factory-wrapper-target.js': 'module.exports = true;',
    'scripts/valid.js': 'module.exports = true;',
    'scripts/result-target.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'commonjs-createRequire', 'scripts/main.js', 'scripts/factory-target.js'), false);
  assert.equal(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/factory-wrapper-target.js'), false);
  assert.ok(edge(result, 'commonjs-createRequire', 'scripts/main.js', 'scripts/valid.js'));
  assert.equal(edge(result, 'commonjs-createRequire', 'scripts/main.js', 'scripts/result-target.js'), false);
});

test('recognizes wrappers forwarding through aliased CommonJS loader functions', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const requireAlias = require;',
      'const moduleRequireAlias = module.require;',
      'function loadAfterAlias(specifier) { return requireAlias(specifier); }',
      'const loadModuleAlias = name => moduleRequireAlias(name);',
      "loadAfterAlias('./first.js');",
      "loadModuleAlias('./second.js');"
    ].join(' '),
    'scripts/first.js': 'module.exports = 1;',
    'scripts/second.js': 'module.exports = 2;'
  });
  assert.ok(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/first.js'));
  assert.ok(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/second.js'));
});

test('keeps dynamic wrapper arguments uncertain and rejects wrappers with shadowed require', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function loadLocal(specifier) { return require(specifier); }',
      'function shadowed(specifier, require) { return require(specifier); }',
      'loadLocal(runtimeName);',
      "shadowed('./not-loaded.js', customLoader);"
    ].join(' '),
    'scripts/not-loaded.js': 'module.exports = true;'
  });
  assert.equal(edge(result, 'commonjs-require-wrapper', 'scripts/main.js', 'scripts/not-loaded.js'), false);
  assert.ok(result.uncertainty.some(item => item.kind === 'require-wrapper' &&
    item.certainty === 'unresolved-require-wrapper-argument'));
});

test('propagates a single static specifier argument into an imported dynamic-import function', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./target.js');"
    ].join(' '),
    'scripts/loader.js': 'export function load(specifier) { return import(specifier); }',
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'));
  assert.equal(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import'
  ), false);
});

test('does not guess a dynamic-import target when imported function callsites disagree', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./first.js');",
      "load('./second.js');"
    ].join(' '),
    'scripts/loader.js': 'export function load(specifier) { return import(specifier); }',
    'scripts/first.js': 'export const first = true;',
    'scripts/second.js': 'export const second = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/first.js'), false);
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/second.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import'
  ));
});

test('keeps cross-module dynamic-import arguments uncertain when any callsite is unknown', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./known.js');",
      'load(runtimeSpecifier);'
    ].join(' '),
    'scripts/loader.js': 'export function load(specifier) { return import(specifier); }',
    'scripts/known.js': 'export const known = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/known.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import'
  ));
});

test('resolves package self-reference export-star barrels for imported loader functions', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', name: 'fixture-suite', exports: {
      './loader': './scripts/loader.js',
      './bridge': './scripts/bridge.js'
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from 'fixture-suite/bridge';",
      "load('./target.js');"
    ].join(' '),
    'scripts/bridge.js': "export * from 'fixture-suite/loader';",
    'scripts/loader.js': 'export function load(specifier) { return import(specifier); }',
    'scripts/target.js': 'export const target = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'));
});

test('resolves package self-reference re-exports while building imported-function summaries', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', name: 'fixture-suite', exports: {
      './loader': './scripts/loader.js',
      './bridge': './scripts/bridge.js'
    }, scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from 'fixture-suite/bridge';",
      "load('./target.js');"
    ].join(' '),
    'scripts/bridge.js': "export { load } from 'fixture-suite/loader';",
    'scripts/loader.js': 'export function load(specifier) { return import(specifier); }',
    'scripts/target.js': 'export const target = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'));
});


test('does not propagate static imported arguments into reassigned dynamic-import parameters', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./target.js');"
    ].join(' '),
    'scripts/loader.js': [
      'export function load(specifier) {',
      "  specifier = runtimeOverride || specifier;",
      '  return import(specifier);',
      '}'
    ].join(' '),
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import'
  ));
});

test('does not propagate static imported arguments when a dynamic-import parameter is incremented or updated', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./target.js');"
    ].join(' '),
    'scripts/loader.js': [
      'export function load(specifier) {',
      '  specifier++;',
      '  return import(specifier);',
      '}'
    ].join(' '),
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import'
  ));
});


test('propagates imported dynamic-import arguments through a same-module wrapper', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      'function wrapper(specifier) { return load(specifier); }',
      "wrapper('./target.js');"
    ].join('\n'),
    'scripts/loader.js': 'export function load(specifier) { return import(specifier); }',
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'));
  assert.equal(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import'
  ), false);
});

test('propagates imported dynamic-import arguments through multiple module wrapper layers', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { wrap } from './wrapper.js';",
      "wrap('./target.js');"
    ].join('\n'),
    'scripts/wrapper.js': [
      "import { load } from './loader.js';",
      'export function wrap(specifier) { return load(specifier); }'
    ].join('\n'),
    'scripts/loader.js': 'export function load(specifier) { return import(specifier); }',
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'));
  assert.equal(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import'
  ), false);
});

test('keeps imported dynamic-import arguments uncertain when an intermediate wrapper has an unknown callsite', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      'function wrapper(specifier) { return load(specifier); }',
      "wrapper('./target.js');",
      'wrapper(runtimeSpecifier);'
    ].join('\n'),
    'scripts/loader.js': 'export function load(specifier) { return import(specifier); }',
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import'
  ));
});

test('does not propagate imported dynamic-import arguments when a nested closure can reassign the parameter', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./target.js');"
    ].join('\n'),
    'scripts/loader.js': [
      'export function load(specifier) {',
      '  const replace = () => { specifier = runtimeOverride; };',
      '  replace();',
      '  return import(specifier);',
      '}'
    ].join('\n'),
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import'
  ));
});

test('does not propagate imported dynamic-import arguments when destructuring assigns to the parameter', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./target.js');"
    ].join('\n'),
    'scripts/loader.js': [
      'export function load(specifier) {',
      '  ({ value: specifier } = runtimeOverride);',
      '  return import(specifier);',
      '}'
    ].join('\n'),
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import'
  ));
});

test('does not propagate imported dynamic-import arguments when a loop writes to the parameter', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./target.js');"
    ].join('\n'),
    'scripts/loader.js': [
      'export function load(specifier) {',
      '  for (specifier of runtimeSpecifiers) {}',
      '  return import(specifier);',
      '}'
    ].join('\n'),
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.equal(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'), false);
  assert.ok(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import' &&
    item.certainty === 'unresolved-dynamic-import'
  ));
});

test('does not treat a shadowed nested parameter as reassignment of an imported loader parameter', () => {
  const result = run({
    'package.json': JSON.stringify({ type: 'module', scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      "import { load } from './loader.js';",
      "load('./target.js');"
    ].join('\n'),
    'scripts/loader.js': [
      'export function load(specifier) {',
      '  const replace = specifier => { specifier = runtimeOverride; };',
      '  return import(specifier);',
      '}'
    ].join('\n'),
    'scripts/target.js': 'export const loaded = true;'
  });
  assert.ok(edge(result, 'dynamic-import', 'scripts/loader.js', 'scripts/target.js'));
  assert.equal(result.uncertainty.some(item =>
    item.file === 'scripts/loader.js' && item.kind === 'dynamic-import'
  ), false);
});

test('resolves listener objects forwarded through multiple helper layers', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const listener = { handleEvent(event) { return event.type; } };',
      'function installAtFinalLayer(value) { document.addEventListener("click", value); }',
      'function forwardOneLayer(value) { installAtFinalLayer(value); }',
      'function forwardAnotherLayer(value) { forwardOneLayer(value); }',
      'forwardAnotherLayer(listener);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' && item.expression === 'document.addEventListener');
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-object-event-handler-binding');
  assert.ok(registration.callbackTarget?.includes('function@'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('keeps reassigned listener helper parameters unresolved across forwarding', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const listener = { handleEvent(event) { return event.type; } };',
      'function install(value) { value = replacement; document.addEventListener("click", value); }',
      'install(listener);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' && item.expression === 'document.addEventListener');
  assert.ok(registration);
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.ok(result.uncertainty.some(item => item.kind === 'unresolved-external-callback-owner'));
});

test('keeps multi-hop listener forwarding unresolved when one caller is unknown', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'const listener = { handleEvent(event) { return event.type; } };',
      'function install(value) { document.addEventListener("click", value); }',
      'function forward(value) { install(value); }',
      'forward(listener);',
      'forward(runtimeListener);'
    ].join(' ')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' && item.expression === 'document.addEventListener');
  assert.ok(registration);
  assert.equal(registration.certainty, 'unresolved-callback-owner');
  assert.ok(result.uncertainty.some(item => item.kind === 'unresolved-external-callback-owner'));
});

test('recognizes event callbacks installed through Object.defineProperty descriptors', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(event) { return event.data; }',
      'Object.defineProperty(window, "onmessage", { configurable: true, value: onMessage });'
    ].join('\n')
  });
  const registration = result.dynamicSites.find(item =>
    item.kind === 'external-callback-registration' &&
    item.expression === 'Object.defineProperty');
  assert.ok(registration);
  assert.equal(registration.certainty, 'resolved-function-binding');
  assert.ok(registration.callbackTarget.endsWith('::onMessage@1:9'));
  assert.equal(result.uncertainty.filter(item =>
    item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('does not infer event callbacks from accessors or computed descriptor names', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(event) { return event.data; }',
      'Object.defineProperty(window, runtimeName, { get() { return onMessage; } });',
      'Object.defineProperty(window, "onmessage", { get() { return onMessage; } });'
    ].join('\n')
  });
  assert.equal(result.dynamicSites.some(item =>
    item.kind === 'external-callback-registration' &&
    item.expression === 'Object.defineProperty'), false);
});

test('recognizes lifecycle callbacks on locally registered custom elements', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'class ScripturePanel extends HTMLElement {',
      '  connectedCallback() { this.ready = true; }',
      '  disconnectedCallback() { this.ready = false; }',
      '  adoptedCallback() { this.adopted = true; }',
      '  attributeChangedCallback(name, oldValue, newValue) { this[name] = newValue; }',
      '}',
      'customElements.define("scripture-panel", ScripturePanel);'
    ].join('\n')
  });
  const registrations = result.dynamicSites.filter(item =>
    item.kind === 'external-callback-registration' &&
    item.certainty === 'resolved-inline-callback' &&
    item.expression === 'customElements.define');
  assert.equal(registrations.length, 4, JSON.stringify(registrations));
  assert.equal(result.uncertainty.filter(item =>
    item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('does not treat unregistered classes, non-elements, or shadowed HTMLElement as lifecycle roots', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'class UnregisteredPanel extends HTMLElement { connectedCallback() {} }',
      'class OrdinaryClass { connectedCallback() {} }',
      'function make(HTMLElement) {',
      '  class ShadowedPanel extends HTMLElement { connectedCallback() {} }',
      '  customElements.define("shadowed-panel", ShadowedPanel);',
      '}'
    ].join('\n')
  });
  assert.equal(result.dynamicSites.some(item =>
    item.kind === 'external-callback-registration' &&
    item.expression === 'customElements.define'), false);
});

test('recognizes statically named event handlers installed through Reflect.set and Object.assign', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(event) { return event.data; }',
      'Reflect.set(window, "onmessage", onMessage);',
      'Object.assign(window, { onerror: onMessage });'
    ].join('\n')
  });
  const registrations = result.dynamicSites.filter(item =>
    item.kind === 'external-callback-registration' &&
    (item.expression === 'Reflect.set' || item.expression === 'Object.assign'));
  assert.equal(registrations.length, 2, JSON.stringify(registrations));
  assert.ok(registrations.every(item => item.certainty === 'resolved-function-binding'));
  assert.ok(registrations.every(item => item.callbackTarget.endsWith('::onMessage@1:9')));
});

test('keeps dynamic Reflect.set event names outside resolved callback ownership', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMessage(event) { return event.data; }',
      'Reflect.set(window, eventName, onMessage);'
    ].join('\n')
  });
  assert.equal(result.dynamicSites.some(item =>
    item.kind === 'external-callback-registration' && item.expression === 'Reflect.set'), false);
});

test('recognizes Vue Composition API lifecycle callback registrations', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'import { onMounted, onBeforeUnmount, onErrorCaptured } from "vue";',
      'function mounted() { return ready(); }',
      'onMounted(mounted);',
      'onBeforeUnmount(() => cleanup());',
      'onErrorCaptured((error, instance, info) => report(error));'
    ].join('\n')
  });
  const registrations = result.dynamicSites.filter(item =>
    item.kind === 'external-callback-registration' &&
    ['onMounted', 'onBeforeUnmount', 'onErrorCaptured'].includes(item.expression));
  assert.equal(registrations.length, 3);
  assert.ok(registrations.some(item =>
    item.expression === 'onMounted' &&
    item.callback === 'mounted' &&
    item.certainty === 'resolved-function-binding'));
  assert.equal(registrations.filter(item =>
    item.certainty === 'resolved-inline-callback').length, 2);
  assert.equal(result.uncertainty.filter(item =>
    item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('does not classify same-named local functions as Vue lifecycle registrations', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onMounted(callback) { return callback(); }',
      'onMounted(() => cleanup());'
    ].join('\n')
  });
  assert.equal(result.dynamicSites.some(item =>
    item.kind === 'external-callback-registration' && item.expression === 'onMounted'), false);
});

test('resolves callbacks read from static object and array registries', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onReady() { return true; }',
      'const objectHandlers = { ready: onReady };',
      'const arrayHandlers = [onReady];',
      'setTimeout(objectHandlers.ready, 0);',
      'setTimeout(arrayHandlers[0], 0);'
    ].join('\\n')
  });
  const registrations = result.dynamicSites.filter(item =>
    item.kind === 'external-callback-registration' && item.expression === 'setTimeout');
  assert.equal(registrations.length, 2);
  assert.ok(registrations.every(item => item.certainty === 'resolved-stored-callback-binding'));
  assert.ok(registrations.every(item => item.callbackTarget.endsWith('::onReady@1:9')));
  assert.equal(result.uncertainty.filter(item =>
    item.kind === 'unresolved-external-callback-owner').length, 0);
});

test('does not resolve callbacks from dynamically indexed or mutated registries', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': [
      'function onReady() { return true; }',
      'const handlers = [onReady];',
      'handlers.push(replacement);',
      'setTimeout(handlers[index], 0);',
      'setTimeout(handlers[0], 0);'
    ].join('\\n')
  });
  const registrations = result.dynamicSites.filter(item =>
    item.kind === 'external-callback-registration' && item.expression === 'setTimeout');
  assert.equal(registrations.length, 2);
  assert.ok(registrations.every(item => item.certainty === 'unresolved-callback-owner'));
  assert.ok(result.uncertainty.some(item => item.kind === 'unresolved-external-callback-owner'));
});
