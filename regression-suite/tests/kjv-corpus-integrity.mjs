import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2] || 'extension');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const context = vm.createContext({
  console, Set, Map, Object, Number, String, Array, Math, RegExp, JSON, Buffer,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  window: {}
});
context.self = context;

for (const file of [
  'books.js',
  'kjv-corpus-word-index.js',
  'kjv-corpus-word-verse-index.js',
  'kjv-corpus-verses.js',
  'kjv-corpus-phrase-index.js',
  'kjv-corpus-original-case.js',
  'kjv-corpus-case-verse-index.js'
]) vm.runInContext(read(file), context, { filename: file });

const books = vm.runInContext('BOOKS', context);
const verses = vm.runInContext('KJV_CORPUS_VERSES', context);
const originalCase = vm.runInContext('KJV_CORPUS_ORIGINAL_CASE', context);
const words = vm.runInContext('KJV_CORPUS_WORD_INDEX', context);
const postings = vm.runInContext('KJV_CORPUS_WORD_VERSE_INDEX', context);

assert(Array.isArray(books) && books.length === 66, 'Expected 66 canonical books; got ' + books?.length);
assert(Array.isArray(verses), 'KJV_CORPUS_VERSES must be an array');
assert.equal(verses.length, 31102, 'Expected 31,102 KJV verses; got ' + verses.length);
assert(Array.isArray(originalCase), 'KJV_CORPUS_ORIGINAL_CASE must be an array');
assert.equal(originalCase.length, verses.length, 'Original-case corpus length differs from verse corpus');
assert(words instanceof Set, 'KJV_CORPUS_WORD_INDEX must be a Set');
assert(postings && typeof postings === 'object' && !Array.isArray(postings), 'Word-to-verse postings must be an object');

const bookByNumber = new Map(books.map(book => [Number(book.bookNumber), book]));
assert.equal(bookByNumber.size, 66, 'Canonical book numbers are not unique');
const seen = new Set();
const expected = new Set();
for (const book of books) {
  const bookNumber = Number(book.bookNumber);
  assert(Number.isInteger(bookNumber), 'Invalid canonical book number: ' + book.bookNumber);
  assert.equal(Number(book.chapterCount), book.verses.length, 'Chapter count mismatch for ' + book.name);
  for (let chapter = 1; chapter <= book.verses.length; chapter++) {
    const count = Number(book.verses[chapter - 1]);
    assert(Number.isInteger(count) && count > 0, 'Invalid verse count for ' + book.name + ' chapter ' + chapter);
    for (let verse = 1; verse <= count; verse++) expected.add(bookNumber + ':' + chapter + ':' + verse);
  }
}
assert.equal(expected.size, 31102, 'Canonical book metadata does not describe exactly 31,102 verses');
const derivedWords = new Set();
const tokenPattern = /[A-Za-z]+(?:['-][A-Za-z]+)*/g;

for (let index = 0; index < verses.length; index++) {
  const entry = verses[index];
  assert(Array.isArray(entry) && entry.length >= 4, 'Verse ' + index + ' must be [book, chapter, verse, text]');
  const bookNumber = Number(entry[0]), chapter = Number(entry[1]), verse = Number(entry[2]);
  const text = String(entry[3] ?? '');
  assert(Number.isInteger(bookNumber) && bookByNumber.has(bookNumber), 'Invalid book number at corpus index ' + index);
  assert(Number.isInteger(chapter) && chapter >= 1, 'Invalid chapter at corpus index ' + index);
  assert(Number.isInteger(verse) && verse >= 1, 'Invalid verse number at corpus index ' + index);
  assert(text.trim().length > 0, 'Empty KJV verse text at corpus index ' + index);
  const book = bookByNumber.get(bookNumber);
  assert(chapter <= book.verses.length, 'Chapter outside ' + book.name + ' at corpus index ' + index);
  assert(verse <= Number(book.verses[chapter - 1]), 'Verse outside ' + book.name + ' ' + chapter + ' at corpus index ' + index);
  const key = bookNumber + ':' + chapter + ':' + verse;
  assert(!seen.has(key), 'Duplicate verse identifier ' + key);
  seen.add(key);

  assert(expected.has(key), 'Verse identifier is not present in canonical book metadata: ' + key);


  const original = originalCase[index];
  assert(Array.isArray(original) && original.length >= 4, 'Original-case verse ' + index + ' has invalid shape');
  assert.deepEqual([Number(original[0]), Number(original[1]), Number(original[2])],
    [bookNumber, chapter, verse], 'Original-case reference mismatch at corpus index ' + index);
  assert.equal(String(original[3] ?? ''), text, 'Original-case text differs at ' + key);
  for (const match of text.matchAll(tokenPattern)) derivedWords.add(match[0].toLowerCase());
}

assert.equal(seen.size, expected.size, 'Verse identifier count differs from canonical book metadata');
const missingReferences = [...expected].filter(key => !seen.has(key));
assert.equal(missingReferences.length, 0, 'Canonical verses missing from corpus (' + missingReferences.length + '): ' + missingReferences.slice(0, 20).join(', '));

const indexedWords = new Set([...words].map(word => String(word).toLowerCase()));
assert.equal(indexedWords.size, words.size, 'Word index contains case-normalized duplicates');
const missingWords = [...derivedWords].filter(word => !indexedWords.has(word));
const staleWords = [...indexedWords].filter(word => !derivedWords.has(word));
assert.equal(missingWords.length, 0, 'Corpus tokens missing from word index (' + missingWords.length + '): ' + missingWords.slice(0, 20).join(', '));
assert.equal(staleWords.length, 0, 'Word index has tokens absent from corpus (' + staleWords.length + '): ' + staleWords.slice(0, 20).join(', '));

function decodePostingIndices(encoded, word) {
  const bytes = Buffer.from(String(encoded), 'base64');
  const result = [];
  let value = 0, shift = 0, previous = 0;
  for (const byte of bytes) {
    value += (byte & 127) * (2 ** shift);
    if (byte & 128) {
      shift += 7;
      assert(shift <= 28, 'Invalid varint in postings for "' + word + '"');
      continue;
    }
    previous += value;
    result.push(previous);
    value = 0;
    shift = 0;
  }
  assert.equal(shift, 0, 'Truncated varint in postings for "' + word + '"');
  return result;
}

for (const word of indexedWords) {
  assert(Object.hasOwn(postings, word), 'Word index entry has no postings: "' + word + '"');
  const indices = decodePostingIndices(postings[word], word);
  assert(indices.length > 0, 'Empty postings for "' + word + '"');
  let previous = -1;
  for (const index of indices) {
    assert(Number.isInteger(index) && index >= 0 && index < verses.length, 'Out-of-range posting ' + index + ' for "' + word + '"');
    assert(index > previous, 'Duplicate or unordered posting ' + index + ' for "' + word + '"');
    previous = index;
    const tokens = String(verses[index][3]).toLowerCase().match(tokenPattern) || [];
    assert(tokens.some(token => token.toLowerCase() === word), 'False posting: "' + word + '" absent from verse index ' + index);
  }
}

console.log('KJV corpus integrity PASS — ' + verses.length + ' verses, ' + books.length + ' books, ' + indexedWords.size + ' distinct indexed words; original-case corpus and all word postings verified.');
