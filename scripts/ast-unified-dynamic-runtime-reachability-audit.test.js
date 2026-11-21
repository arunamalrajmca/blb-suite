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


test('propagates bounded file arrays through helper parameters and defaults', () => {
  const result = run({
    'package.json': JSON.stringify({ scripts: { audit: 'node scripts/main.js' } }),
    'scripts/main.js': 'module.exports = true;',
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }),
    'extension/background.js': "const defaultFiles = ['scripts/default-one.js', 'scripts/default-two.js']; function register(files) { chrome.scripting.registerContentScripts([{ id: 'forwarded', js: files }]); } function ensure(files = defaultFiles) { register(files); } ensure();",
    'extension/scripts/default-one.js': 'globalThis.one = true;',
    'extension/scripts/default-two.js': 'globalThis.two = true;'
  });
  assert.ok(edge(result, 'chrome.scripting.registerContentScripts', 'extension/background.js', 'extension/scripts/default-one.js'));
  assert.ok(edge(result, 'chrome.scripting.registerContentScripts', 'extension/background.js', 'extension/scripts/default-two.js'));
  assert.equal(result.uncertainty.filter(item => item.kind === 'chrome.scripting.registerContentScripts').length, 0);
});
