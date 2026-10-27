#!/usr/bin/env node
/**
 * Extraction safety: manifest load order, file existence, and module registration.
 * Keep this structural so future extractions can move implementation without
 * freezing unrelated function names or source layout.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));

function position(list, name, description) {
  const index = list.indexOf(name);
  assert.notEqual(index, -1, description + ': missing ' + name);
  return index;
}
function before(list, earlier, later, description) {
  assert.ok(position(list, earlier, description) < position(list, later, description),
    description + ': ' + earlier + ' must load before ' + later);
}

try {
  const scripts = (manifest.content_scripts || []).flatMap(entry => entry.js || []);
  assert.ok(scripts.length > 0, 'manifest must declare content scripts');
  assert.equal(new Set(scripts).size, scripts.length, 'manifest content script list must not contain duplicates');
  for (const file of scripts) {
    assert.ok(fs.existsSync(path.join(extension, file)), 'manifest content script must exist: ' + file);
  }
  console.log('PASS: every manifest content script exists and is listed once');

  const primary = (manifest.content_scripts || []).find(entry => (entry.js || []).includes('content.js'));
  assert.ok(primary, 'content.js must be part of a declarative content-script entry');
  assert.equal(primary.run_at, 'document_start', 'content runtime must retain document_start injection');
  const orderedDependencies = [
    'regex-patterns.js',
    'kjv-corpus-word-index.js',
    'books.js',
    'book-aliases.js',
    'reference-core.js',
    'source-bible-redirect.js',
    'multiverse-copy.js',
    'study-reference-capture.js',
    'criteria-search-navigation.js',
    'blb-auto-hyperlinker.js',
    'blb-passive-new-tab-targets.js',
    'blb-draggable-button.js',
    'blb-parse-popup.js',
    'blb-verse-link-navigation.js',
    'blb-page-selection-button.js',
    'multiverse-handoff.js',
    'multiverse-tool-view.js',
    'content.js'
  ];
  for (let i = 1; i < orderedDependencies.length; i++) {
    before(scripts, orderedDependencies[i - 1], orderedDependencies[i], 'content-script dependency order');
  }
  before(scripts, 'books.js', 'reference-core.js', 'book data must precede shared resolver');
  before(scripts, 'reference-core.js', 'kings-bible-collector.js', 'shared resolver must precede collectors');
  before(scripts, 'reference-core.js', 'webster-collector.js', 'shared resolver must precede collectors');
  before(scripts, 'reference-core.js', 'source-page-collector.js', 'shared resolver must precede collectors');
  before(scripts, 'reference-core.js', 'content.js', 'shared resolver must precede content runtime');
  console.log('PASS: content script bootstrap and extracted feature load order are preserved');

  const worker = manifest.background && manifest.background.service_worker;
  assert.ok(worker, 'manifest service worker entry must exist');
  assert.ok(fs.existsSync(path.join(extension, worker)), 'manifest service worker file must exist: ' + worker);
  const background = read(path.join('extension', worker));
  const imports = [...background.matchAll(/importScripts\(([^)]*)\)/g)];
  assert.ok(imports.length > 0, 'service worker must explicitly import its shared dependencies');
  const importedFiles = imports.flatMap(match => {
    const values = match[1].matchAll(/['"]([^'"]+\.js)['"]/g);
    return [...values].map(value => value[1]);
  });
  assert.ok(importedFiles.length > 0, 'service worker importScripts must contain JavaScript paths');
  for (const file of importedFiles) {
    assert.ok(fs.existsSync(path.join(extension, file)), 'service-worker dependency must exist: ' + file);
  }
  before(importedFiles, 'regex-patterns.js', 'books.js', 'service-worker bootstrap order');
  before(importedFiles, 'books.js', 'reference-core.js', 'service-worker shared resolver order');
  console.log('PASS: service-worker imports resolve to existing files in dependency order');

  // Extracted modules must expose their documented global registration objects
  // before content.js executes. Check the global API rather than internal bodies.
  const moduleContracts = [
    ['extension/kings-bible-collector.js', /globalThis\.BLBKingsBibleCollector\s*=|globalThis\.BLBKingsBibleCollector\s*\|\|/],
    ['extension/webster-collector.js', /globalThis\.BLBWebsterCollector\s*=|globalThis\.BLBWebsterCollector\s*\|\|/],
    ['extension/source-page-collector.js', /globalThis\.BLBSourcePageCollectorModule\s*=|globalThis\.BLBSourcePageCollectorModule\s*\|\|/],
    ['extension/source-bible-redirect.js', /globalThis\.BLBSourceBibleRedirectModule\s*=|globalThis\.BLBSourceBibleRedirectModule\s*\|\|/],
    ['extension/multiverse-copy.js', /globalThis\.BLBMultiVerseCopyModule\s*=|globalThis\.BLBMultiVerseCopyModule\s*\|\|/],
    ['extension/study-reference-capture.js', /globalThis\.BLBStudyReferenceCaptureModule\s*=|globalThis\.BLBStudyReferenceCaptureModule\s*\|\|/],
    ['extension/criteria-search-navigation.js', /globalThis\.BLBCriteriaSearchNavigationModule\s*=|globalThis\.BLBCriteriaSearchNavigationModule\s*\|\|/],
    ['extension/blb-auto-hyperlinker.js', /globalThis\.BLBAutoHyperlinkerModule\s*=|globalThis\.BLBAutoHyperlinkerModule\s*\|\|/],
    ['extension/blb-passive-new-tab-targets.js', /globalThis\.BLBPassiveNewTabTargetsModule\s*=|globalThis\.BLBPassiveNewTabTargetsModule\s*\|\|/],
    ['extension/blb-draggable-button.js', /globalThis\.BLBDraggableButtonModule\s*=|globalThis\.BLBDraggableButtonModule\s*\|\|/],
    ['extension/blb-parse-popup.js', /globalThis\.BLBParsePopupModule\s*=|globalThis\.BLBParsePopupModule\s*\|\|/],
    ['extension/blb-verse-link-navigation.js', /globalThis\.BLBVerseLinkNavigationModule\s*=|globalThis\.BLBVerseLinkNavigationModule\s*\|\|/],
    ['extension/blb-page-selection-button.js', /globalThis\.BLBPageSelectionButtonModule\s*=|globalThis\.BLBPageSelectionButtonModule\s*\|\|/],
    ['extension/multiverse-handoff.js', /globalThis\.BLBMultiVerseHandoffModule\s*=|globalThis\.BLBMultiVerseHandoffModule\s*\|\|/],
    ['extension/multiverse-tool-view.js', /globalThis\.BLBMultiVerseToolViewModule\s*=|globalThis\.BLBMultiVerseToolViewModule\s*\|\|/]
  ];
  for (const [file, contract] of moduleContracts) {
    assert.ok(fs.existsSync(path.join(root, file)), 'expected extracted module exists: ' + file);
    assert.match(read(file), contract, 'module must register its global API: ' + file);
  }
  console.log('PASS: extracted content modules register explicit global APIs');

  console.log('All extraction safety contracts passed.');
} catch (error) {
  console.error('FAIL: extraction safety contracts:', error.stack || error.message);
  process.exitCode = 1;
}
