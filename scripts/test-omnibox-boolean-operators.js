#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/omnibox-search-helpers.js'), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'omnibox-boolean-operators.js' });
const api = context.globalThis.BLBOmniboxSearchHelpers;
assert.equal(typeof api?.normalizeBooleanOperatorsOutsideQuotes, 'function');
assert.equal(typeof api?.hasUnquotedBooleanOperator, 'function');
for (const [input, expected] of [
  ['faith and hope', 'faith AND hope'],
  ['faith "and or not" hope', 'faith "and or not" hope'],
  ["LORD'S AND GOD", "LORD'S AND GOD"],
  ['faith\\\\ AND hope', 'faith\\\\ AND hope']
]) assert.equal(api.normalizeBooleanOperatorsOutsideQuotes(input), expected, input);
for (const input of ['faith and hope', "LORD'S AND GOD", 'faith "quoted and phrase" or hope']) assert.equal(api.hasUnquotedBooleanOperator(input), true, input);
for (const input of ['faith "and or not"', 'ORACLE faith', 'android hope', 'candy hope']) assert.equal(api.hasUnquotedBooleanOperator(input), false, input);
console.log('PASS: Omnibox Boolean operator contracts');
