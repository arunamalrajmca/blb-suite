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

// Build invisible Unicode characters by code point so these fixtures test the actual
// characters rather than depending on source-file escape spelling.
const nbsp = String.fromCharCode(0x00a0);
const figureSpace = String.fromCharCode(0x2007);
const narrowNbsp = String.fromCharCode(0x202f);
const zeroWidthSpace = String.fromCharCode(0x200b);
const bidiStart = String.fromCharCode(0x202e);
const bidiEnd = String.fromCharCode(0x202c);
const lineSeparator = String.fromCharCode(0x2028);
const paragraphSeparator = String.fromCharCode(0x2029);

for (const [input, expected] of [
  [`John${nbsp}3:16${figureSpace}3:17`, 'John 3:16 3:17'],
  [`John${narrowNbsp}3:16`, 'John 3:16'],
  [`John${zeroWidthSpace} 3:16`, 'John 3:16'],
  [`${bidiStart}John 3:16${bidiEnd}`, 'John 3:16'],
  [`faith${lineSeparator}and${paragraphSeparator}hope`, 'faith and hope'],
  [null, ''],
  ['', ''],
  ['  John   3:16  ', 'John 3:16'],
  ['John\u00a03:16\u20073:17', 'John 3:16 3:17'],
  ['John\u202f3:16', 'John 3:16'],
  ['John\u200b 3:16', 'John 3:16'],
  ['\u202eJohn 3:16\u202c', 'John 3:16'],
  ['faith\n\tand hope', 'faith and hope'],
  ["  LORD'S   word!  ", "LORD'S word!"],
  ['Romans 1:3–4', 'Romans 1:3-4'],
  ['𝐑𝐨𝐦𝐚𝐧𝐬 𝟏𝟎:𝟗–𝟏𝟐', 'Romans 10:9-12'],
  ['Ｒｏｍａｎｓ　１０：９－１２', 'Romans 10:9-12'],
  ['1\u200f Corinthians ４:１７', '1 Corinthians 4:17']
]) assert.equal(normalize(input), expected, JSON.stringify(input));
console.log('PASS: selection-text normalization contracts');
