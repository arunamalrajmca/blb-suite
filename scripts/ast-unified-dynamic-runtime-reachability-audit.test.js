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
