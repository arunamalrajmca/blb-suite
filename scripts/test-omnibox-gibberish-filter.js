#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../extension/omnibox-search-helpers.js'), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'omnibox-gibberish-filter.js' });
const isGibberish = context.globalThis.BLBOmniboxSearchHelpers?.isObviouslyGibberishQuery;
assert.equal(typeof isGibberish, 'function', 'module must expose the gibberish filter');

const cases = [
  ['', true],
  ['   ', true],
  [';ogo;hgdg', true],
  ['@@@asdf###', true],
  ['x!!qz@@12', true],
  ['qz#@!$%', true],
  ['bcdfg', true],
  ['Jesus!', false],
  ["Lord's prayer", false],
  ['faith-love', false],
  ['Melchizedek', false],
  ['John 3:16', false],
  ['grace and truth', false],
  ['resurrection', false],
  ['Psalm 23:1-6', false]
];
for (const [input, expected] of cases) {
  assert.equal(isGibberish(input), expected, JSON.stringify(input));
}
console.log('PASS: Omnibox gibberish-filter contracts');
