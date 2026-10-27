#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../extension/selection-text-helpers.js'), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'selection-text-normalization.js' });
const normalize = context.globalThis.BLBSelectionTextHelpers?.normalizeSelectedScriptureText;
assert.equal(typeof normalize, 'function', 'module must expose the selection text normalizer');

for (const [input, expected] of [
  [null, ''],
  ['', ''],
  ['  John   3:16  ', 'John 3:16'],
  ['John\\u00a03:16\\u20073:17', 'John 3:16 3:17'],
  ['John\\u202f3:16', 'John 3:16'],
  ['John\\u200b 3:16', 'John 3:16'],
  ['\\u202eJohn 3:16\\u202c', 'John 3:16'],
  ['faith\\n\\tand hope', 'faith and hope'],
  ['  LORD\\'S   word!  ', "LORD'S word!"],
  ['Romans 1:3–4', 'Romans 1:3–4']
]) assert.equal(normalize(input), expected, JSON.stringify(input));
console.log('PASS: selection-text normalization contracts');
