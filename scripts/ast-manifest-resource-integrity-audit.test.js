'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { auditManifest } = require('./ast-manifest-resource-integrity-audit');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-manifest-resources-'));
  return {
    root,
    write(file, content = '') {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

test('validates MV3 entry points, icons, content scripts, CSS, and HTML references', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'background.js' },
      options_page: 'options.html',
      action: { default_popup: 'popup.html', default_icon: { 16: 'icon16.png' } },
      icons: { 48: 'icon48.png' },
      content_scripts: [{ js: ['content.js'], css: ['content.css'] }]
    }));
    for (const file of ['background.js', 'options.html', 'popup.html', 'icon16.png', 'icon48.png', 'content.js', 'content.css', 'popup.js', 'popup.css', 'popup.png']) f.write(file);
    f.write('popup.html', '<script src="popup.js"></script><link rel="stylesheet" href="popup.css"><img src="popup.png">');
    const result = auditManifest(f.root);
    assert.deepEqual(result.errors, []);
    assert.ok(result.references.some(item => item.path === 'background.js' && item.kind === 'service worker'));
    assert.ok(result.references.some(item => item.path === 'content.css' && item.kind === 'content stylesheet'));
    assert.ok(result.references.some(item => item.path === 'popup.js' && item.kind === 'HTML script'));
  } finally { f.cleanup(); }
});

test('reports missing manifest and HTML resources with their owning fields', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'missing-worker.js' },
      action: { default_popup: 'missing-popup.html' }
    }));
    f.write('page.html', '<script src="missing-script.js"></script>');
    const result = auditManifest(f.root);
    assert.ok(result.errors.some(error => error.includes('background.service_worker')));
    assert.ok(result.errors.some(error => error.includes('action.default_popup')));
    assert.ok(result.errors.some(error => error.includes('missing HTML script')));
  } finally { f.cleanup(); }
});

test('rejects manifest and HTML paths that escape the extension root', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: '../outside.js' }
    }));
    f.write('page.html', '<script src="../outside.js"></script>');
    const result = auditManifest(f.root);
    assert.ok(result.errors.some(error => error.includes('escapes extension root')));
  } finally { f.cleanup(); }
});

test('validates web accessible resources and reports missing explicit files', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      web_accessible_resources: [{ resources: ['assets/present.json', 'assets/missing.json'], matches: ['<all_urls>'] }]
    }));
    f.write('assets/present.json');
    const result = auditManifest(f.root);
    assert.ok(result.references.some(item => item.path === 'assets/present.json'));
    assert.ok(result.errors.some(error => error.includes('missing web-accessible resource: assets/missing.json')));
  } finally { f.cleanup(); }
});


test('checks wildcard web-accessible resource patterns against actual packaged files', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      web_accessible_resources: [{ resources: ['assets/*.js'], matches: ['<all_urls>'] }]
    }));
    f.write('assets/one.js');
    const result = auditManifest(f.root);
    assert.ok(result.errors.every(error => !error.includes('assets/*.js')));
    assert.ok(result.references.some(item => item.path === 'assets/one.js'));
  } finally { f.cleanup(); }
});

test('reports wildcard patterns that match no packaged resources', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      web_accessible_resources: [{ resources: ['assets/*.missing'], matches: ['<all_urls>'] }]
    }));
    f.write('assets/present.js');
    const result = auditManifest(f.root);
    assert.ok(result.errors.some(error => error.includes('matches no packaged files')));
  } finally { f.cleanup(); }
});

test('checks CSS url and import resources plus additional manifest resource owners', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      default_locale: 'en',
      declarative_net_request: { rule_resources: [{ id: 'rules', enabled: true, path: 'rules.json' }] },
      theme: { images: { theme_frame: 'theme.png' } }
    }));
    f.write('_locales/en/messages.json', '{}');
    f.write('rules.json', '{}');
    f.write('theme.png');
    f.write('styles/main.css', '@import \"./nested.css\"; .icon { background: url(\"../images/icon.svg\"); }');
    f.write('styles/nested.css', '.nested { background: url(\"../images/missing.svg\"); }');
    f.write('images/icon.svg', '<svg/>');
    const result = auditManifest(f.root);
    assert.ok(result.references.some(item => item.kind === 'locale messages'));
    assert.ok(result.references.some(item => item.kind === 'declarative ruleset'));
    assert.ok(result.errors.some(error => error.includes('missing CSS referenced resource: ../images/missing.svg')));
  } finally { f.cleanup(); }
});

test('rejects symlinks that resolve outside the extension package root', () => {
  const f = fixture();
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-extension-file-'));
  try {
    const outside = path.join(outsideDirectory, 'outside.js');
    fs.writeFileSync(outside, 'outside');
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'escape.js' }
    }));
    fs.symlinkSync(outside, path.join(f.root, 'escape.js'));
    const result = auditManifest(f.root);
    assert.ok(result.errors.some(error => error.includes('symlink escapes extension root')));
  } finally {
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
    f.cleanup();
  }
});

test('normalizes extension-root-relative and URL-encoded manifest resource paths', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: '/background%2Ejs' }
    }));
    f.write('background.js');
    const result = auditManifest(f.root);
    assert.deepEqual(result.errors, []);
    assert.ok(result.references.some(item => item.path === 'background.js'));
  } finally { f.cleanup(); }
});


test('detects symlink escapes reached through wildcard resource patterns', () => {
  const f = fixture();
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-extension-wildcard-'));
  try {
    const outside = path.join(outsideDirectory, 'outside.js');
    fs.writeFileSync(outside, 'outside');
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      web_accessible_resources: [{ resources: ['assets/*.js'], matches: ['<all_urls>'] }]
    }));
    fs.mkdirSync(path.join(f.root, 'assets'), { recursive: true });
    fs.symlinkSync(outside, path.join(f.root, 'assets/escape.js'));
    const result = auditManifest(f.root);
    assert.ok(result.errors.some(error => error.includes('symlink escapes extension root')));
    assert.ok(result.errors.some(error => error.includes('wildcard resolves through symlink outside extension root')));
  } finally {
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
    f.cleanup();
  }
});

test('allows external HTML resources but rejects external manifest resource paths', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'https://example.invalid/worker.js' }
    }));
    f.write('page.html', '<script src=\"https://example.invalid/page.js\"></script>');
    const result = auditManifest(f.root);
    assert.ok(result.errors.some(error => error.includes('external URL is not a packaged resource path')));
    assert.ok(!result.errors.some(error => error.includes('example.invalid/page.js')));
  } finally { f.cleanup(); }
});

test('does not split data URLs into false srcset resource references', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({ manifest_version: 3 }));
    f.write('page.html', '<img srcset=\"data:image/png;base64,AAAA 1x, image.png 2x\">');
    f.write('image.png');
    const result = auditManifest(f.root);
    assert.deepEqual(result.errors, []);
    assert.ok(result.references.some(item => item.path === 'image.png'));
  } finally { f.cleanup(); }
});


test('checks JavaScript module, importScripts, runtime URL, URL constructor, and injection resources', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      background: { service_worker: 'background.js' }
    }));
    f.write('background.js', [
      "import './modules/helper.js';",
      "importScripts('./worker-helper.js');",
      "chrome.runtime.getURL('assets/icon.svg');",
      "new URL('./assets/font.woff2', import.meta.url);",
      "chrome.scripting.executeScript({ files: ['injected.js'] });",
      "chrome.scripting.registerContentScripts([{ js: ['registered.js'] }]);",
      "new URL('worker.js', chrome.runtime.getURL('/'));"
    ].join('\n'));
    for (const file of [
      'modules/helper.js', 'worker-helper.js', 'assets/icon.svg', 'assets/font.woff2',
      'injected.js', 'registered.js', 'worker.js'
    ]) f.write(file);
    const result = auditManifest(f.root);
    assert.deepEqual(result.errors, []);
    for (const file of ['modules/helper.js', 'worker-helper.js', 'assets/icon.svg', 'assets/font.woff2', 'injected.js', 'registered.js', 'worker.js']) {
      assert.ok(result.references.some(item => item.path === file), file);
    }
  } finally { f.cleanup(); }
});

test('reports missing JavaScript-owned resources and dynamic URL targets separately', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({ manifest_version: 3 }));
    f.write('background.js', [
      "chrome.runtime.getURL('missing.png');",
      "new URL('./missing.svg', import.meta.url);",
      "chrome.runtime.getURL(dynamicAssetName);",
      "importScripts(dynamicScriptName);"
    ].join('\n'));
    const result = auditManifest(f.root);
    assert.ok(result.errors.some(error => error.includes('missing runtime.getURL resource: missing.png')));
    assert.ok(result.errors.some(error => error.includes('missing JavaScript URL relative to import.meta.url resource: ./missing.svg')));
    assert.ok(result.uncertainties.some(item => item.kind === 'dynamic-runtime-getURL-resource'));
    assert.ok(result.uncertainties.some(item => item.kind === 'dynamic-importScripts-resource-target'));
  } finally { f.cleanup(); }
});

test('checks storage schema and legacy page-action manifest resources', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 2,
      storage: { managed_schema: 'schema.json' },
      page_action: { default_popup: 'page-action.html', default_icon: 'page-action.png' }
    }));
    f.write('schema.json');
    f.write('page-action.html');
    f.write('page-action.png');
    const result = auditManifest(f.root);
    assert.deepEqual(result.errors, []);
    assert.ok(result.references.some(item => item.kind === 'managed storage schema'));
    assert.ok(result.references.some(item => item.kind === 'popup'));
    assert.ok(result.references.some(item => item.kind === 'icon'));
  } finally { f.cleanup(); }
});


test('includes packaged dist files in wildcard checks and reports CSS variable URLs as uncertainty', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({
      manifest_version: 3,
      web_accessible_resources: [{ resources: ['dist/*.js'], matches: ['<all_urls>'] }]
    }));
    f.write('dist/runtime.js');
    f.write('styles/dynamic.css', '.icon { background-image: url(var(--icon-url)); }');
    const result = auditManifest(f.root);
    assert.deepEqual(result.errors, []);
    assert.ok(result.references.some(item => item.path === 'dist/runtime.js'));
    assert.ok(result.uncertainties.some(item => item.kind === 'dynamic-css-resource-url'));
  } finally { f.cleanup(); }
});


test('reports external directory symlinks and internal directory symlinks as an explicit boundary', () => {
  const f = fixture();
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-extension-assets-'));
    fs.writeFileSync(path.join(outside, 'asset.js'), 'outside');
    f.write('manifest.json', JSON.stringify({ manifest_version: 3 }));
    fs.symlinkSync(outside, path.join(f.root, 'external-assets'), 'dir');
    fs.mkdirSync(path.join(f.root, 'internal-assets'));
    f.write('internal-assets/asset.js');
    fs.symlinkSync(path.join(f.root, 'internal-assets'), path.join(f.root, 'internal-assets-link'), 'dir');
    const result = auditManifest(f.root);
    assert.ok(result.errors.some(error => error.includes('symlink escapes extension root')));
    assert.ok(result.uncertainties.some(item => item.kind === 'internal-directory-symlink-not-traversed'));
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { f.cleanup(); }
});


test('checks file-backed userScripts registrations in extension JavaScript', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({ manifest_version: 3 }));
    f.write('background.js', "chrome.userScripts.register([{ js: [{ file: 'user-script.js' }] }]);");
    f.write('user-script.js');
    const result = auditManifest(f.root);
    assert.deepEqual(result.errors, []);
    assert.ok(result.references.some(item => item.path === 'user-script.js' && item.kind === 'runtime userScripts js'));
  } finally { f.cleanup(); }
});


test('validates resource references through aliased require, importScripts, runtime URL and injection APIs', () => {
  const f = fixture();
  try {
    f.write('manifest.json', JSON.stringify({ manifest_version: 3 }));
    f.write('background.js', [
      'const load = require; load(\"./module.js\");',
      'const loadWorker = importScripts; loadWorker(\"./worker.js\");',
      'const getURL = chrome.runtime.getURL; getURL(\"assets/icon.svg\");',
      'const inject = chrome.scripting.executeScript; inject({ files: [\"injected.js\"] });'
    ].join('\n'));
    for (const file of ['module.js', 'worker.js', 'assets/icon.svg', 'injected.js']) f.write(file);
    const result = auditManifest(f.root);
    assert.deepEqual(result.errors, []);
    for (const file of ['module.js', 'worker.js', 'assets/icon.svg', 'injected.js']) {
      assert.ok(result.references.some(item => item.path === file), file);
    }
  } finally { f.cleanup(); }
});
