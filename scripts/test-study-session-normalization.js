const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'study-session-normalization.js'), 'utf8');
const context = { Map, Set, String, Number, Array, RegExp, JSON };
vm.createContext(context);
vm.runInContext(source, context);
const helpers = context.BLBStudySessionNormalization.createStudySessionNormalizationHelpers({
  canonicalStoredRef(item) {
    if (!item || !['John', 'Psalms'].includes(item.book)) return null;
    const from = item.from == null ? null : Number(item.from);
    const to = item.to == null ? from : Number(item.to);
    return { book:item.book, bookNumber:item.book === 'John' ? 43 : 19, chapter:Number(item.chapter), from, to, text:item.book + ' ' + item.chapter + (from == null ? '' : ':' + from + (to !== from ? '-' + to : '')), version:String(item.version || 'kjv').toLowerCase() };
  }
});

assert.equal(helpers.normalizeStudyNoteKey('  Grace   of GOD '), 'grace of god');
assert.equal(helpers.titleCaseStudyNote('the grace of GOD'), 'The Grace of God');
assert.equal(helpers.canonicalStoredStrong('h00430'), 'H430');
assert.equal(helpers.canonicalStoredStrong('G0'), null);
assert.equal(helpers.studyTopicStorageKey({title:' Grace   of God '}), 'grace of god');

const sessions = [
  {title:'Grace', refs:[{book:'John',chapter:3,from:16,to:16},{book:'John',chapter:3,from:16,to:16}], strongs:['h00430','H430','G25'], searchTerms:['  Grace  ','grace','mercy'], notes:['jesus','the grace of GOD','The Grace of God','Prayer']},
  {title:'grace', refs:[{book:'John',chapter:3,from:16,to:16}], strongs:['H430'], searchTerms:['MERCY'], notes:['prayer']},
  {title:'Prayer', refs:[{book:'Psalms',chapter:23,from:1,to:1}], strongs:['G25'], searchTerms:[], notes:[]}
];
const result = helpers.sanitizeStudySessions(sessions);
assert.equal(result.changed, true);
assert.equal(result.sessions[0].refs.length, 1, 'duplicate canonical references are removed');
assert.equal(result.sessions[1].refs.length, 0, 'reference deduplication spans sessions in the same topic');
assert.deepEqual(Array.from(result.sessions[0].strongs), ['H430','G25'].sort((a,b)=>a[0].localeCompare(b[0])||Number(a.slice(1))-Number(b.slice(1))));
assert.deepEqual(Array.from(result.sessions[0].searchTerms), ['Grace','mercy']);
assert.deepEqual(Array.from(result.sessions[0].notes), ['The Grace of God','Prayer']);
assert.deepEqual(Array.from(result.sessions[1].notes), []);
assert.equal(helpers.sanitizeStudySessions(null).sessions.length, 0);
console.log('PASS: Study Sessions normalization, canonicalization, and topic-wide deduplication contracts');
