#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../extension/selection-marker-stripping.js'), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'selection-marker-stripping.js' });
const strip = context.globalThis.BLBSelectionMarkerStripping?.stripLeadingSelectionMarkers;
assert.equal(typeof strip, 'function', 'module must expose marker stripping');

for (const [input, expected] of [
  [null, ''],
  ['', ''],
  ['  John 3:16  ', 'John 3:16'],
  ['**John 3:16**', 'John 3:16'],
  ['• Verse 3: John 3:16', 'John 3:16'],
  ['Verse 12 - For God so loved', 'For God so loved'],
  ['1. John 3:16', 'John 3:16'],
  ['B) John 3:16', 'John 3:16'],
  ['iv. John 3:16', 'John 3:16'],
  ['I. John 3:16', 'I. John 3:16'],
  ['— • **Verse 2: _Grace_**', 'Grace'],
  ['*  •  A)  iii)  John 3:16  *', 'John 3:16']
]) assert.equal(strip(input), expected, JSON.stringify(input));
console.log('PASS: selection-marker stripping contracts');
