const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'study-session-export.js'), 'utf8');
const context = { Map, Set, String, Number, Array, RegExp, btoa: value => Buffer.from(value, 'binary').toString('base64') };
vm.createContext(context);
vm.runInContext(source, context);

const helpers = context.BLBStudySessionExport.createStudySessionExportHelpers({
  studyBookCanonicalKey(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'psalm' || normalized === 'psalms') return 'psalms';
    return normalized;
  },
  studyBookDisplayName(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'psalm' || normalized === 'psalms') return 'Psalms';
    if (normalized === 'john') return 'John';
    return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : '';
  },
  sortStudyRefs(refs) {
    return [...refs].sort((a, b) =>
      (a.bookNumber - b.bookNumber) || (a.chapter - b.chapter) ||
      ((a.from == null ? 0 : a.from) - (b.from == null ? 0 : b.from)) ||
      ((a.to == null ? 0 : a.to) - (b.to == null ? 0 : b.to)) ||
      String(a.version || 'kjv').localeCompare(String(b.version || 'kjv'))
    );
  }
});

assert.equal(helpers.displayStudyDate('2026-10-27'), '10/27/2026');
assert.equal(helpers.displayStudyDate('legacy-date'), 'legacy-date');
assert.equal(helpers.parseStudyFilter(' Topic: Grace ', 'topic'), 'Grace');
assert.equal(helpers.parseStudyFilter('date: 2026-10-27', 'date'), '2026-10-27');
assert.equal(helpers.parseStudyFilter('other: Grace', 'topic'), '');

const sessions = [
  { title: 'Grace', date: '2026-10-27' },
  { title: 'grace', date: '2026-10-28' },
  { title: 'Prayer', date: '2026-10-27' },
  { title: 'Grace', date: '2026-10-28' }
];
assert.deepEqual(Array.from(helpers.filterStudySessions(sessions, 'topic: GRACE')), [sessions[0], sessions[1], sessions[3]]);
assert.deepEqual(Array.from(helpers.filterStudySessions(sessions, 'date: 2026-10-27')), [sessions[0], sessions[2]]);
assert.deepEqual(Array.from(helpers.studySessionTopics([
  { title: ' Grace ' }, { title: 'grace' }, { title: 'Uncategorized' }, { title: '' }, { title: 'Prayer' }
])), ['Grace', 'Prayer']);

const exported = helpers.studySessionText({
  title: 'Grace', date: '2026-10-27',
  refs: [
    { book: 'Psalm', bookNumber: 19, chapter: 12, from: 6, to: 7, text: 'Psalm 12:6-7' },
    { book: 'Psalms', bookNumber: 19, chapter: 12, from: 6, to: 7, text: 'Psalms 12:6-7' },
    { book: 'John', bookNumber: 43, chapter: 3, from: 16, to: 16, text: 'John 3:16' }
  ],
  strongs: ['H430'], searchTerms: ['grace', 'mercy'], notes: ['Jesus', 'Jesus Christ', 'Prayer']
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

const pdf = helpers.buildStudySessionsPdf(['TITLE: Grace', exported].join('\n'));
assert.match(pdf, /^[A-Za-z0-9+/]+=*$/, 'PDF builder should return base64 data');
assert.ok(Buffer.from(pdf, 'base64').subarray(0, 8).toString('ascii').startsWith('%PDF-'), 'decoded export should be a PDF');

console.log('PASS: Study Sessions formatting, filtering, aliases, duplicate references, notes, and PDF contracts');
