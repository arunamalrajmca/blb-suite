'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover } = require('./ast-executable-source-coverage-audit');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-executable-roots-'));
  const extension = path.join(root, 'extension');
  fs.mkdirSync(extension, { recursive: true });
  return {
    root,
    write(relative, content) {
      const filename = path.join(root, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

test('accounts for manifest worker, content scripts, HTML scripts, and static worker imports', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'background.js' },
      content_scripts: [{ js: ['content.js', 'shared.js'] }]
    }));
    f.write('extension/background.js', 'importScripts("./worker-dependency.js");');
    f.write('extension/worker-dependency.js', 'self.ready = true;');
    f.write('extension/content.js', 'window.contentReady = true;');
    f.write('extension/shared.js', 'window.sharedReady = true;');
    f.write('extension/popup.html', '<script src="popup.js"></script>');
    f.write('extension/popup.js', 'window.popupReady = true;');

    const result = discover(f.root);
    const byFile = new Map(result.entries.map(item => [item.file, item]));
    for (const file of [
      'extension/background.js',
      'extension/worker-dependency.js',
      'extension/content.js',
      'extension/shared.js',
      'extension/popup.js'
    ]) {
      assert.equal(byFile.get(file).classification, 'statically-rooted-or-imported', file);
    }
    assert.equal(result.summary.unaccountedFor, 0);
  } finally {
    f.cleanup();
  }
});

test('reports JavaScript without a discovered execution root instead of calling it unused', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'background.js' }
    }));
    f.write('extension/background.js', 'self.ready = true;');
    f.write('extension/legacy-helper.js', 'function legacyHelper() {}');

    const result = discover(f.root);
    const orphan = result.entries.find(item => item.file === 'extension/legacy-helper.js');
    assert.ok(orphan);
    assert.equal(orphan.classification, 'unaccounted-for');
    assert.deepEqual(orphan.roots, []);
    assert.equal(result.summary.unaccountedFor, 1);
  } finally {
    f.cleanup();
  }
});

test('records dynamic registration and injection sites as unresolved ownership boundaries', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'background.js' }
    }));
    f.write('extension/background.js', [
      'chrome.scripting.registerContentScripts([]);',
      'chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => true });'
    ].join('\n'));

    const result = discover(f.root);
    assert.deepEqual(result.dynamicSites.map(item => item.api), [
      'registerContentScripts',
      'executeScript'
    ]);
    assert.ok(result.dynamicSites.every(item => item.line > 0));
  } finally {
    f.cleanup();
  }
});

test('follows statically named ES module imports from an HTML entry point', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3 }));
    f.write('extension/options.html', '<script type="module" src="options.js"></script>');
    f.write('extension/options.js', 'import { start } from "./options-runtime.js"; start();');
    f.write('extension/options-runtime.js', 'export function start() {}');

    const result = discover(f.root);
    const files = new Set(result.entries.filter(item => item.roots.length).map(item => item.file));
    assert.ok(files.has('extension/options.js'));
    assert.ok(files.has('extension/options-runtime.js'));
  } finally {
    f.cleanup();
  }
});


test('follows static dynamic imports and reports nonliteral imports as uncertainty', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }));
    f.write('extension/background.js', "import('./lazy.js'); import(getModuleName());");
    f.write('extension/lazy.js', 'self.lazyLoaded = true;');
    const result = discover(f.root);
    const lazy = result.entries.find(item => item.file === 'extension/lazy.js');
    assert.equal(lazy.classification, 'statically-rooted-or-imported');
    assert.ok(result.dynamicSites.some(item => item.api === 'dynamic-import' && item.certainty === 'dynamic-module-target'));
  } finally { f.cleanup(); }
});

test('discovers runtime registered scripts, executeScript files, and Worker targets', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }));
    f.write('extension/background.js', [
      "chrome.scripting.registerContentScripts([{ js: ['registered.js'] }]);",
      "chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['injected.js'] });",
      "new Worker(new URL('./worker.js', import.meta.url));"
    ].join('\n'));
    for (const file of ['registered.js', 'injected.js', 'worker.js']) f.write('extension/' + file, 'self.loaded = true;');
    const result = discover(f.root);
    const rooted = new Set(result.entries.filter(item => item.roots.length).map(item => item.file));
    for (const file of ['registered.js', 'injected.js', 'worker.js']) assert.ok(rooted.has('extension/' + file), file);
  } finally { f.cleanup(); }
});

test('handles extension-root-relative and query-suffixed HTML script paths', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3 }));
    f.write('extension/popup.html', '<script src=/popup.js?v=2></script>');
    f.write('extension/popup.js', 'window.ready = true;');
    const result = discover(f.root);
    const popup = result.entries.find(item => item.file === 'extension/popup.js');
    assert.equal(popup.classification, 'statically-rooted-or-imported');
  } finally { f.cleanup(); }
});

test('retains parse failures as explicit uncertainty and unaccounted source inventory', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }));
    f.write('extension/background.js', 'self.ready = true;');
    f.write('extension/legacy.js', 'function ( {');
    const result = discover(f.root);
    const broken = result.entries.find(item => item.file === 'extension/legacy.js');
    assert.equal(broken.parseStatus, 'unparsed');
    assert.ok(result.dynamicSites.some(item => item.file === 'extension/legacy.js' && item.api === 'source-parse'));
  } finally { f.cleanup(); }
});


test('follows literal array and object aliases in importScripts and runtime registration APIs', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }));
    f.write('extension/background.js', [
      "const workerFiles = ['worker-dependency.js']; importScripts(...workerFiles);",
      "const registrations = [{ js: ['registered.js'] }]; chrome.scripting.registerContentScripts(registrations);",
      "const injection = { files: ['injected.js'] }; chrome.scripting.executeScript(1, injection);"
    ].join('\n'));
    for (const file of ['worker-dependency.js', 'registered.js', 'injected.js']) f.write('extension/' + file, 'self.loaded = true;');
    const result = discover(f.root);
    const rooted = new Set(result.entries.filter(item => item.roots.length).map(item => item.file));
    for (const file of ['worker-dependency.js', 'registered.js', 'injected.js']) assert.ok(rooted.has('extension/' + file), file);
  } finally { f.cleanup(); }
});


test('records document.write, insertAdjacentHTML, and innerHTML script injection boundaries', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }));
    f.write('extension/background.js', [
      "document.write('<script src=\"legacy.js\"></script>');",
      "container.insertAdjacentHTML('beforeend', '<script src=\"another.js\"></script>');",
      "container.innerHTML = markup;"
    ].join('\n'));
    const result = discover(f.root);
    const injection = result.dynamicSites.filter(item => item.api.startsWith('dynamic-html-'));
    assert.equal(injection.length, 3);
    assert.ok(injection.some(item => item.targets.includes('legacy.js')));
    assert.ok(injection.some(item => item.targets.includes('another.js')));
    assert.ok(injection.some(item => item.certainty === 'dynamic-markup-or-script-target'));
  } finally { f.cleanup(); }
});


test('includes internal symlinked JavaScript roots and reports external symlink boundaries', () => {
  const f = fixture();
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-extension-source-'));
    fs.writeFileSync(path.join(outside, 'external.js'), 'self.external = true;');
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }));
    f.write('extension/background.js', "importScripts('internal.js', 'external.js');");
    f.write('extension/internal-target.js', 'self.internal = true;');
    fs.symlinkSync(path.join(f.root, 'extension/internal-target.js'), path.join(f.root, 'extension/internal.js'));
    fs.symlinkSync(path.join(outside, 'external.js'), path.join(f.root, 'extension/external.js'));
    const result = discover(f.root);
    const internal = result.entries.find(item => item.file === 'extension/internal.js');
    assert.equal(internal.classification, 'statically-rooted-or-imported');
    assert.ok(result.dynamicSites.some(item => item.api === 'extension-source-symlink' && item.certainty === 'symlink-outside-extension-root'));
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { f.cleanup(); }
});


test('includes legacy manifest background script arrays as execution roots', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({
      manifest_version: 2,
      background: { scripts: ['legacy-background.js'] }
    }));
    f.write('extension/legacy-background.js', 'self.legacyWorker = true;');
    const result = discover(f.root);
    const legacy = result.entries.find(item => item.file === 'extension/legacy-background.js');
    assert.equal(legacy.classification, 'statically-rooted-or-imported');
  } finally { f.cleanup(); }
});


test('records service-worker and user-script registration as runtime ownership boundaries', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }));
    f.write('extension/background.js', [
      "navigator.serviceWorker.register('./page-worker.js');",
      "chrome.userScripts.register([{ id: 'user-script', js: [{ file: 'user-script.js' }] }]);"
    ].join('\n'));
    f.write('extension/page-worker.js');
    f.write('extension/user-script.js');
    const result = discover(f.root);
    assert.ok(result.dynamicSites.some(item => item.api === 'serviceWorker.register' && item.target === './page-worker.js'));
    assert.ok(result.dynamicSites.some(item => item.api === 'userScripts.register'));
    const userScript = result.entries.find(item => item.file === 'extension/user-script.js');
    assert.equal(userScript.classification, 'statically-rooted-or-imported');
  } finally { f.cleanup(); }
});


test('reports inline HTML executable sources outside the JavaScript file inventory', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3 }));
    f.write('extension/page.html', [
      '<script>window.inlineScript = true;</script>',
      '<script type=\"application/ld+json\">{\"name\":\"metadata\"}</script>',
      '<button onclick=\"runAction()\">Run</button>',
      '<a href=\"javascript:runAction()\">Run</a>',
      '<iframe srcdoc=\"inline document\"></iframe>'
    ].join('\n'));
    const result = discover(f.root);
    const apis = result.dynamicSites.map(item => item.api);
    assert.ok(apis.includes('html-inline-script'));
    assert.ok(apis.includes('html-inline-event-handler'));
    assert.ok(apis.includes('html-javascript-url'));
    assert.ok(apis.includes('html-srcdoc'));
    assert.equal(apis.filter(api => api === 'html-inline-script').length, 1);
  } finally { f.cleanup(); }
});


test('follows aliases to importScripts and Chrome script injection APIs', () => {
  const f = fixture();
  try {
    f.write('extension/manifest.json', JSON.stringify({ manifest_version: 3, background: { service_worker: 'background.js' } }));
    f.write('extension/background.js', [
      "const loadScripts = importScripts; loadScripts('worker-alias.js');",
      "const inject = chrome.scripting.executeScript; inject({ files: ['injected-alias.js'] });",
      "const register = chrome.scripting.registerContentScripts; register([{ js: ['registered-alias.js'] }]);"
    ].join('\n'));
    for (const file of ['worker-alias.js', 'injected-alias.js', 'registered-alias.js']) f.write('extension/' + file);
    const result = discover(f.root);
    const rooted = new Set(result.entries.filter(item => item.roots.length).map(item => item.file));
    for (const file of ['worker-alias.js', 'injected-alias.js', 'registered-alias.js']) assert.ok(rooted.has('extension/' + file), file);
  } finally { f.cleanup(); }
});
