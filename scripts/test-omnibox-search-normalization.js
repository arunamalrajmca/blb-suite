#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../extension/omnibox-search-helpers.js'), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'omnibox-search-normalization.js' });
const normalize = context.globalThis.BLBOmniboxSearchHelpers?.normalizeOmniboxSearchPhrase;
assert.equal(typeof normalize, 'function', 'module must expose the normalizer');

const cases = [
  [null, ''],
  ['', ''],
  ['  FAITH   AND   HOPE ', 'faith and hope'],
  ['faith\u00A0and\u202Fhope', 'faith and hope'],
  ['faith\u200B and\uFEFF hope', 'faith and hope'],
  ['“Grace”—works!', 'grace works'],
  ["Jesus’s ‘word’", "jesus's 'word'"],
  ['John 3:16-17', 'john 3 16-17'],
  ['faith\n\tand hope', 'faith and hope']
];
for (const [input, expected] of cases) assert.equal(normalize(input), expected, JSON.stringify(input));
console.log('PASS: Omnibox search normalization contracts');
