#!/usr/bin/env node
/**
 * Characterization tests for shared Bible-reference parsing and resolution.
 * These protect the behavior before any future parser/module-boundary changes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const context = { console };
vm.createContext(context);
for (const file of [
  'extension/books.js',
  'extension/book-aliases.js',
  'extension/reference-core.js'
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
const { resolveBibleReference, resolveBibleReferenceText, resolveDirectBibleReference,
  resolveBibleBook, normalizeBibleReferenceText } = context;

assert.equal(typeof resolveBibleReferenceText, 'function');
assert.equal(typeof resolveBibleReference, 'function');
assert.equal(typeof resolveDirectBibleReference, 'function');

function tuples(input) {
  return JSON.parse(JSON.stringify(
    resolveBibleReferenceText(input).map(({ book, chapter, from, to }) => [book, chapter, from, to])
  ));
}

// Full references, verse ranges, and Unicode dash normalization.
assert.deepEqual(tuples('Romans 1:3–4'), [['romans', 1, 3, 4]]);
assert.deepEqual(tuples('John 3:16'), [['john', 3, 16, 16]]);
assert.deepEqual(tuples('1 John 2:3-5'), [['1 john', 2, 3, 5]]);
assert.deepEqual(tuples('II John 1:4'), [['2 john', 1, 4, 4]]);

// Shorthand lists inherit context in source order, including a chain from a
// comma verse to a semicolon chapter:verse entry.
assert.deepEqual(tuples('John 3:16,17; 4:8'), [
  ['john', 3, 16, 16],
  ['john', 3, 17, 17],
  ['john', 4, 8, 8]
]);

// One-chapter books interpret a bare number as a verse.
assert.deepEqual(tuples('Jude 10'), [['jude', 1, 10, 10]]);
assert.deepEqual(tuples('Obadiah 3-5'), [['obadiah', 1, 3, 5]]);

// Reference resolver clamps known out-of-range values consistently.
const clamped = resolveBibleReference('John', 999, 999, 1000);
assert.equal(clamped.chapter, 21);
assert.equal(clamped.from, 25);
assert.equal(clamped.to, 25);
assert.equal(clamped.url, 'https://www.blueletterbible.org/kjv/jhn/21/25/');

// Direct-reference resolution rejects prose and multi-reference input while
// accepting a single complete reference (optionally suffixed with KJV).
assert.equal(resolveDirectBibleReference('John 3:16 KJV').url,
  'https://www.blueletterbible.org/kjv/jhn/3/16/');
assert.equal(resolveDirectBibleReference('Please read John 3:16'), null);
assert.equal(resolveDirectBibleReference('John 3:16; 17'), null);
assert.equal(resolveDirectBibleReference(''), null);

// Common normalization hazards and ambiguous short aliases.
assert.equal(normalizeBibleReferenceText('John\u00a03:16\u2007'), 'John 3:16');
assert.equal(resolveBibleBook('II John').name, '2 john');
assert.equal(resolveBibleBook('I'), null);
assert.equal(resolveBibleBook('is'), null);

console.log('PASS: shared Bible-reference parsing and resolution contracts');
