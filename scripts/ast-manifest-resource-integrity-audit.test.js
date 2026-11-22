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
