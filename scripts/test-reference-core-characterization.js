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


// Every canonical KJV book must accept both chapter-verse separators.
// This is exhaustive across the 66-book table, rather than a sample of books.
const books = vm.runInContext('BOOKS', context);
assert.equal(books.length, 66, 'the regression matrix must cover all 66 KJV books');
for (const book of books) {
  for (const separator of [':', '.']) {
    const input = `${book.name} 1${separator}1`;
    assert.deepEqual(
      tuples(input),
      [[book.name, 1, 1, 1]],
      `expected ${book.name} to resolve with separator "${separator}" in: ${input}`
    );

    const rangeInput = `${book.name} 1${separator}1-2`;
    assert.deepEqual(
      tuples(rangeInput),
      [[book.name, 1, 1, 2]],
      `expected ${book.name} verse range to resolve with separator "${separator}" in: ${rangeInput}`
    );
    const shorthandInput = `${book.name} 1${separator}1,2`;
    assert.deepEqual(
      tuples(shorthandInput),
      [[book.name, 1, 1, 1], [book.name, 1, 2, 2]],
      `expected ${book.name} shorthand verse list to resolve with separator "${separator}" in: ${shorthandInput}`
    );
  }
}

// Full references, verse ranges, and Unicode dash normalization.
assert.deepEqual(tuples('Luke 22.26'), [['luke', 22, 26, 26]]);
assert.deepEqual(tuples('Romans 1.3-4'), [['romans', 1, 3, 4]]);
assert.deepEqual(tuples('1 Tim. 1.15, 16'), [
  ['1 timothy', 1, 15, 15],
  ['1 timothy', 1, 16, 16]
]);
assert.deepEqual(tuples('John 3.16,17; 4.8'), [
  ['john', 3, 16, 16],
  ['john', 3, 17, 17],
  ['john', 4, 8, 8]
]);
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

// Common Psalm/Proverbs aliases and numbered Thessalonians/Peter aliases.
// Keep these in the shared resolver contract so every action using the core
// recognizes the same abbreviations.
const aliasCases = [
  ['Ps', 'psalms', 'Ps 23:1', ['psalms', 23, 1, 1]],
  ['Psalm', 'psalms', 'Psalm 23:1', ['psalms', 23, 1, 1]],
  ['Psalms', 'psalms', 'Psalms 23:1', ['psalms', 23, 1, 1]],
  ['Prov', 'proverbs', 'Prov 3:5', ['proverbs', 3, 5, 5]],
  ['1 Thes', '1 thessalonians', '1 Thes 4:16', ['1 thessalonians', 4, 16, 16]],
  ['2 Thes', '2 thessalonians', '2 Thes 2:3', ['2 thessalonians', 2, 3, 3]],
  ['1 Pet', '1 peter', '1 Pet 3:15', ['1 peter', 3, 15, 15]],
  ['2 Pet', '2 peter', '2 Pet 1:4', ['2 peter', 1, 4, 4]]
];
for (const [alias, expectedBook, reference, expectedTuple] of aliasCases) {
  assert.equal(
    resolveBibleBook(alias)?.name,
    expectedBook,
    `expected alias "${alias}" to resolve to ${expectedBook}`
  );
  assert.deepEqual(
    tuples(reference),
    [expectedTuple],
    `expected reference "${reference}" to resolve through alias "${alias}"`
  );
}

// These suffixes are ambiguous without their numbered prefix; do not silently
// choose 1 or 2 Thessalonians/Peter.
assert.equal(resolveBibleBook('Thes'), null);
assert.equal(resolveBibleBook('Pet'), null);


console.log('PASS: shared Bible-reference parsing and resolution contracts');
