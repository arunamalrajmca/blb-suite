const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'multiverse-reference-helpers.js'), 'utf8');
const context = { Map, Set, String, Number, Array, RegExp };
vm.createContext(context);
vm.runInContext(source, context);

const bookData = [
  { bookNumber: 19, name: 'Psalms', chapterCount: 2, verses: [6, 4] },
  { bookNumber: 43, name: 'John', chapterCount: 3, verses: [51, 25, 36] }
];
function canonicalStoredRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bookNumber = Number(raw.bookNumber);
  const chapter = Number(raw.chapter);
  if (!Number.isInteger(bookNumber) || !Number.isInteger(chapter) || chapter < 1) return null;
  const from = raw.from == null ? null : Number(raw.from);
  const to = raw.to == null ? null : Number(raw.to);
  if ((from != null && (!Number.isInteger(from) || from < 1))
      || (to != null && (!Number.isInteger(to) || to < 1))
      || (from != null && to != null && to < from)) return null;
  return { book: raw.book || '', bookNumber, chapter, from, to, version: String(raw.version || 'kjv').toLowerCase() };
}
const h = context.BLBMultiVerseReferenceHelpers.createMultiVerseReferenceHelpers({ canonicalStoredRef, bookData });

const set = h.canonicalMultiVerseSet([
  { bookNumber: 43, chapter: 3, from: 16, to: 16 },
  { bookNumber: 43, chapter: 3, from: 16, to: 16 },
  { bookNumber: 19, chapter: 1, verse: 3 }
]);
assert.equal(set.refs.length, 2, 'canonical set deduplicates equivalent references');
assert.ok(set.key.includes('19|1|3|3|kjv'), 'single verse input is preserved as a verse reference');
assert.deepEqual(Array.from(h.expandMultiVerseRefsToVerses([
  { bookNumber: 19, chapter: 1, from: 2, to: 4 },
  { bookNumber: 19, chapter: 1, from: 4, to: 6 }
])).map(v => v.from), [2, 3, 4, 5, 6], 'overlapping refs expand without duplicate verses');

assert.deepEqual({ ...h.getContinuousSameChapterRange([
  { bookNumber: 43, chapter: 3, from: 16, to: 17 },
  { bookNumber: 43, chapter: 3, from: 18, to: 18 }
]) }, { bookNumber: 43, chapter: 3, from: 16, to: 18, version: 'kjv' });
assert.equal(h.getContinuousSameChapterRange([
  { bookNumber: 43, chapter: 3, from: 16, to: 17 },
  { bookNumber: 43, chapter: 3, from: 20, to: 21 }
]), null, 'gapped ranges must not be compacted into a continuous range');

assert.deepEqual(Array.from(h.compactMultiVerseVerses([
  { bookNumber: 43, chapter: 3, from: 16, to: 16, version: 'kjv' },
  { bookNumber: 43, chapter: 3, from: 17, to: 17, version: 'kjv' },
  { bookNumber: 43, chapter: 3, from: 20, to: 20, version: 'kjv' }
]).map(v => [v.from, v.to])), [[16, 17], [20, 20]]);
console.log('PASS: MultiVerse canonicalization, expansion, deduplication, and range-compaction contracts');
