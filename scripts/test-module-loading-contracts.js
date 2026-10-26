#!/usr/bin/env node
/**
 * Regression guards for classic-script loading while production code is split
 * into feature modules. These checks intentionally exercise manifest/import
 * contracts without requiring a browser or changing runtime behavior.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const failures = [];
const pass = (message) => console.log('PASS:', message);
const fail = (message) => failures.push(message);
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

let manifest;
try {
  manifest = JSON.parse(read('extension/manifest.json'));
} catch (error) {
  console.error('FAIL: cannot parse extension/manifest.json:', error.message);
  process.exit(1);
}

const expectedContentScripts = [
  'regex-patterns.js',
  'kjv-corpus-word-index.js',
  'books.js',
  'book-aliases.js',
  'reference-core.js',
  'kings-bible-collector.js',
  'content.js'
];
const contentEntry = (manifest.content_scripts || []).find(entry =>
  (entry.js || []).includes('content.js')
);
if (!contentEntry) {
  fail('manifest declares a content-script entry containing content.js');
} else {
  const actual = contentEntry.js;
  const requiredPositions = expectedContentScripts.map(name => actual.indexOf(name));
  if (requiredPositions.some(index => index < 0)
      || requiredPositions.some((index, i) => i > 0 && index <= requiredPositions[i - 1])) {
    fail('content-script dependencies are present and ordered before content.js: '
      + expectedContentScripts.join(' -> '));
  } else {
    pass('content-script dependency order remains stable');
  }
  if (contentEntry.run_at !== 'document_start') {
    fail('content script remains configured for document_start');
  } else {
    pass('content script initialization timing remains document_start');
  }
}

const background = read('extension/background.js');
const importMatch = background.match(/^\s*importScripts\(([^;]+)\);/);
if (!importMatch) {
  fail('background service worker begins with its classic importScripts bootstrap');
} else {
  const imports = [...importMatch[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map(match => match[1]);
  const required = [
    'regex-patterns.js',
    'kjv-corpus-word-index.js',
    'kjv-corpus-word-verse-index.js',
    'kjv-corpus-verses.js',
    'kjv-corpus-phrase-index.js',
    'kjv-corpus-original-case.js',
    'kjv-case-sensitive-words.js',
    'case-sensitive-search-core.js',
    'case-sensitive-routing.js',
    'kjv-corpus-case-verse-index.js',
    'books.js',
    'book-aliases.js',
    'reference-core.js'
  ];
  const positions = required.map(name => imports.indexOf(name));
  if (positions.some(index => index < 0)
      || positions.some((index, i) => i > 0 && index <= positions[i - 1])) {
    fail('service-worker imports retain dependency order: ' + required.join(' -> '));
  } else {
    pass('service-worker import dependency order remains stable');
  }
  if (background.indexOf('importScripts(') !== background.lastIndexOf('importScripts(')) {
    fail('service-worker bootstrap has a single top-level importScripts call');
  } else {
    pass('service-worker bootstrap importScripts call remains singular');
  }
}

const referenceCore = read('extension/reference-core.js');
if (!referenceCore.includes('function normalizeBibleReferenceText')
    || !referenceCore.includes('function resolveBibleReference')) {
  fail('shared reference core retains the normalization and resolution entry points');
} else {
  pass('shared reference-core entry points remain available');
}
if (/\b(?:document|window)\s*\./.test(referenceCore)) {
  fail('shared reference-core remains free of direct DOM/window property access');
} else {
  pass('shared reference-core has no direct DOM/window property access');
}

const content = read('extension/content.js');
if (!content.includes('window.__blbSuiteContentScriptFileExecutedV3')
    || !content.includes('(async function ()')) {
  fail('content script retains its file-execution marker and async initializer');
} else {
  pass('content script execution marker and async initializer remain present');
}
if (!content.includes('BLBShared.hostnames.blb') || !background.includes('BLBShared.hostnames.blb')) {
  fail('content script and service worker both consume the shared BLB identity API');
} else {
  pass('content script and service worker retain the shared BLB identity contract');
}

if (failures.length) {
  for (const message of failures) console.error('FAIL:', message);
  process.exitCode = 1;
} else {
  console.log('All module-loading contract checks passed.');
}
