const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, 'missing source marker: ' + start);
  assert.notEqual(to, -1, 'missing source marker: ' + end);
  return source.slice(from, to);
}

// Execute the production function declarations with only the book resolver
// and sort dependency stubbed. This tests the actual background.js functions,
// not a duplicated test implementation.
const context = {
  Map, Set, String, Number, Array, RegExp,
  resolveStudyBookIdentity(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'psalm' || normalized === 'psalms') {
      return { name: 'Psalms', urlKey: 'psalms', bookNumber: 19 };
    }
    if (normalized === 'john') return { name: 'John', urlKey: 'john', bookNumber: 43 };
    return null;
  },
  sortStudyRefs(refs) {
    return [...refs].sort((a, b) =>
      (a.bookNumber - b.bookNumber) || (a.chapter - b.chapter) ||
      ((a.from == null ? 0 : a.from) - (b.from == null ? 0 : b.from)) ||
      ((a.to == null ? 0 : a.to) - (b.to == null ? 0 : b.to)) ||
      String(a.version || 'kjv').localeCompare(String(b.version || 'kjv'))
    );
  }
};

vm.createContext(context);
vm.runInContext(
  between('function displayStudyDate(', 'function buildStudySessionsPdf(') +
  between('function parseStudyFilter(', 'async function exportStudySessions('),
  context
);

assert.equal(context.displayStudyDate('2026-10-27'), '10/27/2026');
assert.equal(context.displayStudyDate('legacy-date'), 'legacy-date');
assert.equal(context.parseStudyFilter(' Topic: Grace ', 'topic'), 'Grace');
assert.equal(context.parseStudyFilter('date: 2026-10-27', 'date'), '2026-10-27');
assert.equal(context.parseStudyFilter('other: Grace', 'topic'), '');

const sessions = [
  { title: 'Grace', date: '2026-10-27' },
  { title: 'grace', date: '2026-10-28' },
  { title: 'Prayer', date: '2026-10-27' },
  { title: 'Grace', date: '2026-10-28' }
];
assert.deepEqual(
  Array.from(context.filterStudySessions(sessions, 'topic: GRACE')),
  [sessions[0], sessions[1], sessions[3]]
);
assert.deepEqual(
  Array.from(context.filterStudySessions(sessions, 'date: 2026-10-27')),
  [sessions[0], sessions[2]]
);
assert.deepEqual(
  Array.from(context.studySessionTopics([
    { title: ' Grace ' }, { title: 'grace' }, { title: 'Uncategorized' },
    { title: '' }, { title: 'Prayer' }
  ])),
  ['Grace', 'Prayer']
);

const exported = context.studySessionText({
  title: 'Grace',
  date: '2026-10-27',
  refs: [
    { book: 'Psalm', bookNumber: 19, chapter: 12, from: 6, to: 7, text: 'Psalm 12:6-7' },
    { book: 'Psalms', bookNumber: 19, chapter: 12, from: 6, to: 7, text: 'Psalms 12:6-7' },
    { book: 'John', bookNumber: 43, chapter: 3, from: 16, to: 16, text: 'John 3:16' }
  ],
  strongs: ['H430'],
  searchTerms: ['grace', 'mercy'],
  notes: ['Jesus', 'Jesus Christ', 'Prayer']
});
assert.match(exported, /DATE: 10\/27\/2026/);
assert.equal((exported.match(/BOOK: Psalms/g) || []).length, 1, 'Psalm/Psalms aliases should share one book group');
assert.match(exported, /REFS: 12:6-7/);
assert.match(exported, /BOOK: John\nREFS: 3:16/);
assert.equal((exported.match(/12:6-7/g) || []).length, 1, 'duplicate references should be removed');
assert.match(exported, /STRONGS: H430/);
assert.match(exported, /SEARCH_TERMS: grace \| mercy/);
assert.match(exported, /NOTE: Jesus Christ/);
assert.match(exported, /NOTE: Prayer/);
assert.doesNotMatch(exported, /NOTE: Jesus\n/);
assert.doesNotMatch(exported, /REFS: Psalm 12:6-7/);

console.log('PASS: Study Sessions date, filtering, topics, aliases, duplicate references, and note export contracts');
