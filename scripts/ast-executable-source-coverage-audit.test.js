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
      'chrome.scripting.registerContentScripts',
      'chrome.scripting.executeScript'
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
