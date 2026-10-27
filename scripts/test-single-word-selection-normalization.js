#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../extension/single-word-selection-normalization.js'), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'single-word-selection-normalization.js' });
const normalize = context.globalThis.BLBSingleWordSelectionNormalization?.normalizeSingleWordForKjvVocabulary;
assert.equal(typeof normalize, 'function', 'module must expose the single-word normalizer');

for (const [input, expected] of [
  [null, ''],
  ['', ''],
  ['   ', ''],
  ['Faith', 'faith'],
  ['  ...FAITH!!! ', 'faith'],
  ['123Word456', 'word'],
  ["LORD'S", "lord's"],
  ['well-being', 'well-being'],
  ['3:16', ''],
  ['John 3:16', 'john 3:16']
]) assert.equal(normalize(input), expected, JSON.stringify(input));
console.log('PASS: single-word selection normalization contracts');
