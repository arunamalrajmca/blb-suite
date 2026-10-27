#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../extension/quoted-criteria-or-query.js'), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'quoted-criteria-or-query.js' });
const build = context.globalThis.BLBQuotedCriteriaOrQuery?.makeQuotedCriteriaOrQuery;
assert.equal(typeof build, 'function', 'module must expose the query builder');

const cases = [
  [null, ''],
  [[], ''],
  [['faith', 'hope'], '"faith" OR "hope"'],
  [[' faith ', '', null, 'faith', 'hope '], '"faith" OR "hope"'],
  [['"Jesus"', 'word"of"God'], '"Jesus" OR "wordofGod"'],
  [['one', 'two', 'three'], '"one" OR "two" OR "three"'],
  [['   ', false, 0], '"0"']
];
for (const [input, expected] of cases) assert.equal(build(input), expected, JSON.stringify(input));
console.log('PASS: quoted criteria OR query contracts');
