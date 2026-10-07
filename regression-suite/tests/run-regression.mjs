import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(HERE, '..', 'extension');
const ROOT = path.resolve(process.argv[2] || defaultRoot);
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures.json'), 'utf8'));
const expectedVersion = process.env.BLB_EXPECTED_VERSION || JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const failures = [];
let passed = 0;
const requestedGroup = process.argv.find(arg => arg.startsWith('--group='))?.slice('--group='.length) || 'all';
let currentGroup = 'features';
function section(group) { currentGroup = group; }
function test(name, fn) {
  if (requestedGroup !== 'all' && requestedGroup !== currentGroup) return;
  try { fn(); passed++; console.log(`✓ [${currentGroup}] ${name}`); }
  catch (e) { failures.push({name, error:e.message, group:currentGroup}); console.log(`✗ [${currentGroup}] ${name}\n  ${e.message}`); }
}
function read(name){ return fs.readFileSync(path.join(ROOT,name),'utf8'); }
function sha256(file){ return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex'); }
function loadPure(files){
  const ctx = vm.createContext({console, Set, Map, Object, Number, String, Array, Math, RegExp, JSON, Buffer, atob: (value) => Buffer.from(value, 'base64').toString('binary'), window:{}}); ctx.self = ctx;
  for (const file of files) vm.runInContext(read(file), ctx, {filename:file});
  return ctx;
}

console.log(`BLB Suite Regression Suite — manifest ${expectedVersion}`);
console.log(`Package: ${ROOT}\n`);

section('package');
// Manifest/package invariants.
test('manifest JSON + MV3 + version', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, expectedVersion);
  assert.equal(m.background?.service_worker, 'background.js');
});
test('required HTTP/HTTPS host permissions', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.deepEqual(m.host_permissions, ['https://www.blueletterbible.org/*']);
});
test('content-script coverage includes web + local HTML/PDF', () => {
  const m = JSON.parse(read('manifest.json'));
  const matches = m.content_scripts?.flatMap(x=>x.matches||[]) || [];
  for (const expected of ['file:///*.pdf','file:///*.html','file:///*.htm']) assert(matches.includes(expected), expected);
  assert(!matches.includes('http://*/*') && !matches.includes('https://*/*'), 'arbitrary HTTP/HTTPS hosts must not be permanent content-script matches');
});
test('manifest-referenced files exist', () => {
  const m = JSON.parse(read('manifest.json'));
  const refs = [m.background?.service_worker, m.options_page, ...(m.content_scripts||[]).flatMap(x=>x.js||[]), ...Object.values(m.icons||{}), m.action?.default_popup].filter(Boolean);
  for (const f of refs) assert(fs.existsSync(path.join(ROOT,f)), `missing ${f}`);
});
test('no optional host-permission regression', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.deepEqual(m.optional_host_permissions, ['http://*/*','https://*/*']);
});

// Syntax checks for all JS source files.
test('all JavaScript source files parse', () => {
  for (const f of fs.readdirSync(ROOT).filter(x=>x.endsWith('.js'))) {
    new vm.Script(read(f), {filename:f});
  }
});

section('resolver');
// Shared Bible-reference core + production selection extractor.
const refCtx = loadPure(['books.js','book-aliases.js','reference-core.js']);
const bgSource = read('background.js');
test('shared alias source is authoritative for Omnibox and reference resolver', () => {
  const aliasSource = vm.runInContext('EXTRA_BOOK_ALIASES', refCtx);
  const aliasMap = vm.runInContext('BOOK_ALIASES', refCtx);
  assert(aliasSource && Object.keys(aliasSource).length > 0, 'shared alias source is empty');
  const expectedAliases = Object.create(null);
  for (const [alias, target] of Object.entries(aliasSource)) {
    const book = refCtx.BOOKS.find(item => item.name === target);
    assert(book, `alias source target is not a canonical book: ${alias}`);
    const normalized = String(alias).toLowerCase().trim();
    const canonical = String(book.name || '').toLowerCase().trim();
    const urlKey = String(book.urlKey || '').toLowerCase().trim();
    const number = String(book.bookNumber || '').trim();
    if (normalized && normalized !== canonical && normalized !== urlKey && normalized !== number) {
      expectedAliases[normalized] = target;
    }
  }
  assert.deepEqual(aliasMap, expectedAliases, 'derived alias map diverges from shared source');
  for (const [alias, target] of Object.entries(expectedAliases)) {
    assert.equal(refCtx.resolveBibleBook(alias)?.name, target, `reference resolver mismatch: ${alias}`);
    const refs = refCtx.resolveBibleReferenceText(`${alias} 1:1`);
    assert.equal(refs.length, 1, `reference grammar mismatch: ${alias}`);
    assert.equal(refs[0].book, target, `reference grammar target mismatch: ${alias}`);
  }
  assert(bgSource.includes("importScripts('kjv-corpus-word-index.js'"), 'background import list missing');
  assert(bgSource.includes("'book-aliases.js'"), 'background does not import shared alias source');
  assert(bgSource.includes('bookData.forEach(book => { book.aliases = buildBookAliases(book); });'), 'Omnibox book aliases are not built from shared source');
  assert(bgSource.includes('const explicitAlias = BOOK_ALIASES[base] || BOOK_ALIASES[base.replace(/\\s/g,"")];'), 'Omnibox resolver does not use shared alias map');
  assert.equal((read('book-aliases.js').match(/const EXTRA_BOOK_ALIASES\s*=/g) || []).length, 1, 'duplicate alias source detected');
  assert(!read('reference-core.js').includes('const EXTRA_BOOK_ALIASES'), 'reference resolver contains a duplicate alias source');
});

const extractorStart = bgSource.indexOf('function extractBibleRefsFromSelectedTextUncached');
const extractorEnd = bgSource.indexOf('\nfunction ', extractorStart + 10);
vm.runInContext(bgSource.slice(extractorStart, extractorEnd > extractorStart ? extractorEnd : undefined), refCtx, {filename:'background.js:extractBibleRefsFromSelectedTextUncached'});

test('shared core resolves every numbered Bible-book family', () => {
  for (const book of refCtx.BOOKS.filter(book => /^[123] /.test(book.name))) {
    const refs = refCtx.resolveBibleReferenceText(`${book.name} 1:1`);
    assert.equal(refs.length, 1, book.name);
    assert.equal(refs[0].book, book.name, book.name);
    assert.equal(refs[0].chapter, 1, book.name);
    assert.equal(refs[0].from, 1, book.name);
    assert.equal(refs[0].to, 1, book.name);
  }
});
test('shared core normalizes URL-style book separators generically', () => {
  const forms = [
    ['1-John', '1 john'],
    ['1_john', '1 john'],
    ['1-John', '1 john'],
    ['2-Samuel', '2 samuel'],
    ['1_Corinthians', '1 corinthians'],
    ['Song-of-Solomon', 'song of solomon'],
    ['Song_of_Solomon', 'song of solomon']
  ];
  for (const [form, expected] of forms) {
    const book = refCtx.resolveBibleBook(form);
    assert.equal(book?.name, expected, form);
  }
  for (const book of refCtx.BOOKS) {
    const hyphenated = book.name.replace(/ /g, '-');
    const underscored = book.name.replace(/ /g, '_');
    assert.equal(refCtx.resolveBibleBook(hyphenated)?.name, book.name, hyphenated);
    assert.equal(refCtx.resolveBibleBook(underscored)?.name, book.name, underscored);
  }
});

test('reference grammar preserves chapter, verse, and range after URL-style book normalization', () => {
  const cases = [
    ['1-John 5:1-3', '1 john', 5, 1, 3],
    ['1_john 5:1', '1 john', 5, 1, 1],
    ['2-Samuel 12:7-9', '2 samuel', 12, 7, 9],
    ['Song-of-Solomon 2:1-3', 'song of solomon', 2, 1, 3]
  ];
  for (const [input, book, chapter, from, to] of cases) {
    const refs = refCtx.resolveBibleReferenceText(input);
    assert.equal(refs.length, 1, input);
    assert.deepEqual(
      [refs[0].book, refs[0].chapter, refs[0].from, refs[0].to],
      [book, chapter, from, to],
      input
    );
  }
});
test('production selection extractor resolves every Roman-numeral numbered book family', () => {
  const roman = {1: 'I', 2: 'II', 3: 'III'};
  const numbered = refCtx.BOOKS.filter(book => /^[123] /.test(book.name));
  assert(numbered.length > 0);
  for (const book of numbered) {
    const prefix = Number(book.name[0]);
    const form = `${roman[prefix]} ${book.name.slice(2)} 1:1`;
    const refs = refCtx.extractBibleRefsFromSelectedTextUncached(form);
    assert.equal(refs.length, 1, `${form}: ${refs.map(ref => ref.text).join(' | ')}`);
    assert.equal(refs[0].book, book.name, form);
    assert.equal(refs[0].chapter, 1, form);
    assert.equal(refs[0].from, 1, form);
    assert.equal(refs[0].to, 1, form);
  }
  for (const prefix of [...new Set(numbered.map(book => roman[Number(book.name[0])]))]) {
    assert.equal(refCtx.extractBibleRefsFromSelectedTextUncached(prefix).length, 0, `standalone ${prefix} must remain unresolved`);
  }
});
test('multi-reference paragraph extraction covers every numbered book family', () => {
  const roman = {1: 'I', 2: 'II', 3: 'III'};
  const numbered = refCtx.BOOKS.filter(book => /^[123] /.test(book.name));
  const source = numbered.map((book, index) => {
    const prefix = Number(book.name[0]);
    const chapter = (index % book.chapterCount) + 1;
    return `${roman[prefix]} ${book.name.slice(2)} ${chapter}:1`;
  }).join('; ');
  const refs = refCtx.extractBibleRefsFromSelectedTextUncached(source);
  assert.equal(refs.length, numbered.length, refs.map(ref => ref.text).join(' | '));
  refs.forEach((ref, index) => {
    const book = numbered[index];
    assert.equal(ref.book, book.name, book.name);
    assert.equal(ref.chapter, (index % book.chapterCount) + 1, book.name);
    assert.equal(ref.from, 1, book.name);
    assert.equal(ref.to, 1, book.name);
  });
});
test('generic double-click reference grammar resolves all 66 books and every shared alias', () => {
  const books = refCtx.BOOKS;
  assert.equal(books.length, 66);
  const aliasesByBook = Object.create(null);
  for (const [alias, target] of Object.entries(refCtx.BOOK_ALIASES || {})) {
    (aliasesByBook[target] ||= []).push(alias);
  }

  for (const book of books) {
    const canonicalForms = [book.name, book.urlKey];
    const aliases = aliasesByBook[book.name] || [];
    const forms = [...new Set([...canonicalForms, ...aliases])];

    for (const form of forms) {
      const variants = [
        [`${form} 1:1`, 1, 1, 1],
        [`${form} 1:1-2`, 1, 1, 2],
        [`${form} 1.1`, 1, 1, 1],
        [`${form} 1 1`, 1, 1, 1]
      ];
      if (book.chapterCount > 1) variants.push([`${form} 1`, 1, null, null]);
      if (book.chapterCount === 1) variants.push([`${form} 1-2`, 1, 1, 2]);

      for (const [input, chapter, from, to] of variants) {
        const refs = refCtx.resolveBibleReferenceText(input);
        assert.equal(refs.length, 1, `${book.name}: ${input}`);
        assert.equal(refs[0].book, book.name, `${book.name}: ${input}`);
        assert.equal(refs[0].chapter, chapter, `${book.name}: ${input}`);
        if (from !== null) assert.equal(refs[0].from, from, `${book.name}: ${input}`);
        if (to !== null) assert.equal(refs[0].to, to, `${book.name}: ${input}`);
      }
    }
  }

  // Numbered-book Roman forms are tested from the same 66-book source of truth.
  const roman = {1:'I',2:'II',3:'III'};
  for (const book of books.filter(b => /^[123] /.test(b.name))) {
    const n = Number(book.name[0]);
    const remainder = book.name.slice(2);
    const form = `${roman[n]} ${remainder} 1:1`;
    const refs = refCtx.resolveBibleReferenceText(form);
    assert.equal(refs.length, 1, form);
    assert.equal(refs[0].book, book.name, form);
  }

  // Standalone numbers outside the book-number domain must not become books.
  for (const value of ['0','67','68','150','176','99999']) {
    assert.equal(refCtx.resolveBibleBook(value), null, `standalone ${value}`);
  }
  assert.equal(refCtx.resolveBibleBook('I'), null, 'standalone I');
  assert.equal(refCtx.resolveBibleBook('II'), null, 'standalone II');
  assert.equal(refCtx.resolveBibleBook('III'), null, 'standalone III');
});

test('property-based reference grammar generation covers deterministic valid and invalid forms', () => {
  // Deterministic property-style generation: the seed and source-of-truth data
  // make failures reproducible while exercising many combinations beyond the
  // hand-authored matrix above.
  const books = refCtx.BOOKS;
  const aliasesByBook = Object.create(null);
  for (const [alias, target] of Object.entries(refCtx.BOOK_ALIASES || {})) {
    (aliasesByBook[target] ||= []).push(alias);
  }

  let seed = 0x5a17;
  const next = (max) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  };
  const forms = [];
  for (const book of books) {
    forms.push(book.name, book.urlKey);
    for (const alias of aliasesByBook[book.name] || []) forms.push(alias);
  }

  const syntax = [
    (form, ch, verse) => `${form} ${ch}:${verse}`,
    (form, ch, verse) => `${form} ${ch}.${verse}`,
    (form, ch, verse) => `${form} ${ch} ${verse}`,
    (form, ch) => `${form} ${ch}`
  ];

  for (let i = 0; i < 600; i++) {
    const form = forms[next(forms.length)];
    const book = books.find(b =>
      b.name === form ||
      b.urlKey === form ||
      String(b.bookNumber) === form ||
      (aliasesByBook[b.name] || []).includes(form)
    );
    assert(book, `generated form has no source book: ${form}`);

    const chapter = 1 + next(book.chapterCount);
    const verse = 1 + next(8);
    const formatter = syntax[next(syntax.length)];
    const input = formatter(form, chapter, verse);
    const refs = refCtx.resolveBibleReferenceText(input);

    assert.equal(refs.length, 1, `generated reference: ${input}`);
    assert.equal(refs[0].book, book.name, `generated book: ${input}`);
    assert.equal(refs[0].chapter, chapter, `generated chapter: ${input}`);
    if (formatter.length >= 3) assert.equal(refs[0].from, verse, `generated verse: ${input}`);
  }

  for (const invalid of ['0:1', '67:1', '68:1', '999:1', 'I 1:1', 'II 1:1', 'III 1:1']) {
    assert.equal(refCtx.resolveBibleReferenceText(invalid).length, 0, `invalid generated form: ${invalid}`);
  }
});

test('direct reference resolver rejects prose and accepts exact refs', () => {
  assert(refCtx.resolveDirectBibleReference('1 Thessalonians 2:13'));
  assert.equal(refCtx.resolveDirectBibleReference('in every one'), null);
  // Roman numeral handling belongs to the production selection extractor, not the pure core.
  assert(refCtx.extractBibleRefsFromSelectedTextUncached('I Thessalonians 2:13').length === 1);
});

section('features');
// Case-sensitive core + corpus.
const csCtx = loadPure(['case-sensitive-search-core.js','kjv-corpus-original-case.js','kjv-corpus-case-verse-index.js']);
const omniboxCtx = loadPure(['books.js','kjv-corpus-verses.js','kjv-corpus-word-verse-index.js']);
const omniboxBgSource = read('background.js');
const omniboxHelperStart = omniboxBgSource.indexOf('function normalizeOmniboxSearchPhrase');
const omniboxHelperEnd = omniboxBgSource.indexOf('\nasync function handleBCommand', omniboxHelperStart);
if (omniboxHelperStart >= 0 && omniboxHelperEnd > omniboxHelperStart) {
  vm.runInContext(omniboxBgSource.slice(omniboxHelperStart, omniboxHelperEnd), omniboxCtx, {filename:'background.js:omnibox-search-helpers'});
}
test('normal b single-result phrase resolves directly to its verse', () => {
  const match = omniboxCtx.findSingleKjvPhraseMatch('"adoption to wit"');
  assert(match, 'expected unique KJV phrase result');
  assert.deepEqual([Number(match[0]), Number(match[1]), Number(match[2])], [45, 8, 23]);
  assert.equal(omniboxCtx.findSingleKjvPhraseMatch('Jesus'), null, 'multiple results must retain native search');
});
test('quoted normal b single-result path checks direct verse before native quoted search', () => {
  const start = omniboxBgSource.indexOf('const quotedMatch = t.match');
  const end = omniboxBgSource.indexOf('\n  if (low.endsWith("."))', start);
  assert(start >= 0 && end > start, 'quoted b handler block missing');
  const quotedBlock = omniboxBgSource.slice(start, end);
  assert(quotedBlock.includes('const singleMatch = findSingleKjvPhraseMatch(phrase)'), 'quoted path must use single-result resolver');
  assert(quotedBlock.includes("await openSingleKjvVerse(singleMatch, 'currentTab')"), 'quoted single-result path must open the verse directly');
  assert(quotedBlock.includes('chrome.tabs.update({url:'), 'quoted fallback must retain native search');
});
test('b cs single-result phrase resolves directly while multi-result remains MultiVerse', () => {
  const one = csCtx.BLBCaseSensitiveCore.searchCaseSensitiveCorpus('adoption to wit', csCtx.KJV_CORPUS_ORIGINAL_CASE, csCtx.KJV_CORPUS_CASE_VERSE_INDEX);
  assert.equal(one.length, 1);
  assert(omniboxBgSource.includes('if (refs.length === 1)'), 'case-sensitive single-result direct-verse branch missing');
  assert(omniboxBgSource.includes('openSingleKjvVerse([refs[0].bookNumber, refs[0].chapter, refs[0].verse], disposition)'), 'case-sensitive direct-verse opener missing');
});

test('case-sensitive parser preserves raw query', () => {
  const p=csCtx.BLBCaseSensitiveCore.parseCaseSensitiveQuery('b cs "JESUS"');
  // The parser intentionally expects the text after `cs` in this layer.
  assert.equal(p, null);
  const q=csCtx.BLBCaseSensitiveCore.parseCaseSensitiveQuery('cs "JESUS"');
  assert.equal(q.rawQuery,'"JESUS"');
  assert.equal(q.query,'JESUS');
});
test('exact-case corpus search finds JESUS', () => {
  const matches=csCtx.BLBCaseSensitiveCore.searchCaseSensitiveCorpus('Jesus', csCtx.KJV_CORPUS_ORIGINAL_CASE, csCtx.KJV_CORPUS_CASE_VERSE_INDEX);
  assert.equal(matches.length, 929, 'baseline corpus should contain 929 exact-case Jesus matches');
});
test('scrambled-case detection', () => {
  // Load routing separately because it expects the generated Set.
  const routingCtx = loadPure(['kjv-case-sensitive-words.js','case-sensitive-routing.js']);
  assert.equal(routingCtx.hasScrambledCase('jEsUs'), true);
  assert.equal(routingCtx.hasScrambledCase('Jesus'), false);
  assert.equal(routingCtx.hasScrambledCase('JESUS'), false);
});

section('features');
// Static cross-file contracts for high-risk regressions.
const bg=read('background.js');
const content=read('content.js');
section('selection');
test('web contextual resolver is present', () => {
  for (const s of ['getContextualBibleReference','resolveBibleReferenceFromContextWindow','blbSuiteResolveContextualSelection']) assert(bg.includes(s)||content.includes(s), s);
});
test('PDF path uses shared downstream resolver', () => {
  assert(bg.includes('openSelectedPdfBibleRefs'), 'missing PDF shared handler');
  assert(bg.includes('classifySelectionForBlb'), 'PDF path must use shared classifier');
});
test('PDF protected-viewer fallback is explicit', () => {
  assert(bg.includes('Chrome/Brave PDF viewers and protected pages may reject content-script'), 'expected protected PDF fallback comment missing');
});
test('case-sensitive zero-result fallback cannot redirect to BLB home', () => {
  const start=bg.indexOf('async function handleCaseSensitiveBCommand');
  const end=bg.indexOf('\nasync function handleOmniboxCommand', start);
  const fn=bg.slice(start,end);
  assert(fn.includes('openCaseSensitiveNativeSearch(parsed.rawQuery, disposition)'), 'native fallback missing');
  assert(!fn.includes("chrome.tabs.update({url:homeUrl})"), 'unsafe BLB-home fallback remains');
});
test('case-sensitive MultiVerse destinations are rate-limited by tab load', () => {
  const start=bg.indexOf('const CASE_SENSITIVE_MULTI_VERSE_TAB_COOLDOWN_MS');
  const end=bg.indexOf('\nasync function handleCaseSensitiveBCommand', start);
  assert(start >= 0 && end > start, 'case-sensitive destination throttle block missing');
  const fn=bg.slice(start,end);
  assert(fn.includes('CASE_SENSITIVE_MULTI_VERSE_TAB_COOLDOWN_MS'), 'inter-tab cooldown missing');
  assert(fn.includes('setTimeout(resolve, CASE_SENSITIVE_MULTI_VERSE_TAB_COOLDOWN_MS)'), 'inter-tab cooldown must precede subsequent navigation');
  assert(fn.includes('for (let i=1;i<targets.length;i++)'), 'destination loop missing');
  assert(fn.includes('function waitForTabTerminalLoad'), 'terminal tab-load wait helper missing');
  assert(fn.includes('chrome.tabs.onUpdated.addListener'), 'terminal tab-load observer missing');
  assert(fn.includes('chrome.tabs.onUpdated.removeListener(onUpdated)'), 'tab-load observer must be removed after each destination');
  assert(fn.includes('await waitForTabTerminalLoad(tab.id)'), 'each created tab must wait for terminal load');
});

test('case-sensitive URL-builder failure has native fallback', () => {
  const start=bg.indexOf('const urls=buildCaseSensitiveMultiVerseUrls');
  const end=bg.indexOf('await openCaseSensitiveDestinations',start);
  const section=bg.slice(start,end);
  assert(section.includes('openCaseSensitiveNativeSearch(parsed.rawQuery, disposition)'));
});

test('expected PDF limitation remains documented by test policy', () => {
  assert.equal(fixture.pdfPolicy,'expected-limitation');
});

test('Official KJB redirect parser supports chapter and verse URLs', () => {
  const content = read('content.js');
  const start = content.indexOf('if (host==="officialkingjamesbible.com")');
  const end = content.indexOf('\n  if (host==="bibleportal.com")', start);
  assert(start >= 0 && end > start, 'Official KJB redirect block missing');
  const block = content.slice(start, end);
  assert(block.includes('(?:\\/(\\d+))?'), 'Official KJB verse parser missing');
  assert(block.includes('from:m[3]?+m[3]:1'), 'Official KJB verse capture is not used');
});

test('external redirect coverage includes every supported redirect host', () => {
  const content = read('content.js');
  for (const host of ['bible.com','biblegateway.com','bibleref.com','biblehub.com','kingjamesbibleonline.org','kjbo.org','kjv.site','officialkingjamesbible.com','bibleportal.com','webstersdictionary1828.com','blueletterbible.org']) assert(content.includes(host), `redirect host missing: ${host}`);
  assert(content.includes('function redirectBibleSite'), 'Bible-site redirect parser missing');
  assert(content.includes('function redirectBlbNet'), 'BLB NET redirect missing');
  assert(content.includes('const REDIRECT_HOSTS'), 'redirect host table missing');
});
test('BLB native-event interception remains explicitly scoped', () => {
  const content = read('content.js');
  const blbStart = content.indexOf('blueletterbible.org');
  assert(blbStart >= 0, 'BLB content scope missing');
  const blbEnd = content.indexOf('// ---------- Webster', blbStart);
  assert(blbEnd > blbStart, 'BLB content scope boundary missing');
  const blb = content.slice(Math.max(0, blbStart - 80), blbEnd);

  const popup = blb.indexOf('link.closest(".parse-popup")');
  assert(popup >= 0, 'parse-popup click override must remain selector-scoped');
  const popupHandlerEnd = blb.indexOf('});', popup);
  assert(popupHandlerEnd > popup, 'parse-popup click handler boundary missing');
  assert(blb.slice(popup, popupHandlerEnd + 3).includes('preventDefault()'), 'parse-popup override must retain its intentional native-navigation override');

  const nowrap = blb.indexOf('const a=e.target.closest?.("a.nowrap")');
  assert(nowrap >= 0, 'nowrap click override must remain selector-scoped');
  const nowrapEnd = blb.indexOf('},true);', nowrap);
  assert(nowrapEnd > nowrap, 'nowrap click handler boundary missing');
  assert(blb.slice(nowrap, nowrapEnd + 7).includes('if (!a) return'), 'nowrap click override must reject unrelated clicks');

  const selectionStart = content.indexOf('function handleBlbPageSelectionMouseDown');
  const selectionEnd = content.indexOf('function getPageSelectionSiteKey', selectionStart);
  assert(selectionStart >= 0 && selectionEnd > selectionStart, 'selection-monitoring block missing');
  const selection = content.slice(selectionStart, selectionEnd);
  assert(!selection.includes('preventDefault()'), 'selection monitoring must not cancel native events');
  assert(!selection.includes('stopPropagation()'), 'selection monitoring must not stop native propagation');
  assert(!selection.includes('stopImmediatePropagation()'), 'selection monitoring must not stop native propagation');

  const dblStart = content.indexOf('function handleDoubleClickBlb');
  const dblEnd = content.indexOf('function enableDoubleClickBlb', dblStart);
  assert(dblStart >= 0 && dblEnd > dblStart, 'double-click block missing');
  const dbl = content.slice(dblStart, dblEnd);
  assert(!dbl.includes('preventDefault()'), 'double-click resolver must not cancel native dblclick');
  assert(!dbl.includes('stopPropagation()'), 'double-click resolver must not stop native propagation');
  assert(!dbl.includes('stopImmediatePropagation()'), 'double-click resolver must not stop native propagation');
});
test('BLB new-tab and Copy-as-link contracts remain wired', () => {
  const content = read('content.js');
  assert(content.includes('modifyLinks'), 'BLB link modifier missing');
  assert(content.includes('target="_blank"'), 'BLB new-tab target missing');
  assert(content.includes('formatBlbTextToHtml'), 'HTML clipboard formatter missing');
  assert(content.includes('setData("text/html"'), 'HTML clipboard write missing');
  assert(content.includes('setData("text/plain"'), 'plain-text clipboard fallback missing');
});
test('context-menu Show on BLB wiring remains present', () => {
  const bg = read('background.js'), content = read('content.js');
  assert(bg.includes('contextMenus'), 'contextMenus API wiring missing');
  assert(bg.includes('blbSuiteOpenSelectionText'), 'context-menu selection opener missing');
  assert(content.includes('blbSuiteSyncSelectionContextMenu'), 'context-menu synchronization missing');
});
test('Alt+B selection path remains wired', () => {
  const bg = read('background.js');
  assert(bg.includes('Alt+B'), 'Alt+B marker missing');
  assert(bg.includes('getActiveTabSelection'), 'Alt+B active selection path missing');
  assert(bg.includes('chrome.commands.onCommand'), 'extension command listener missing');
});
section('selection');
test('Double-click BLB path remains wired', () => {
  const content = read('content.js');
  assert(content.includes('handleDoubleClickBlb'), 'double-click handler missing');
  assert(content.includes("addEventListener('dblclick'"), 'dblclick listener missing');
  assert(content.includes('blbSuiteOpenSelectionText'), 'double-click opener missing');
});
test('Show on BLB floating button path remains wired', () => {
  const content = read('content.js');
  assert(content.includes('BLB_PAGE_BUTTON_ID'), 'floating button missing');
  assert(content.includes('addBlbPageSelectionButton'), 'button creation missing');
  assert(content.includes('updateBlbPageSelectionButtonFromSelection'), 'selection update path missing');
  assert(content.includes('blbSuiteOpenSelectionText'), 'button opener missing');
});
section('selection');
test('MultiVerse creation/reuse path remains wired', () => {
  const bg = read('background.js');
  assert(bg.includes('createBlbTabGeneric'), 'BLB tab manager missing');
  assert(bg.includes('openSelectedPdfBibleRefs'), 'shared MultiVerse/reference opener missing');
  assert(bg.includes('createBlbTabGeneric'), 'MultiVerse tab creation/reuse missing');
});
section('features');
test('Webster 1828 path remains wired', () => {
  const content = read('content.js'), bg = read('background.js');
  assert(content.includes('webstersdictionary1828.com'), 'Webster host missing');
  assert(content.includes('collectWebsterBibleRefs'), 'Webster collector missing');
  assert(content.includes('blbSuiteOpenBackgroundUrl'), 'Webster opener missing');
  assert(bg.includes('blbSuiteOpenWebsterMultiVerse'), 'Webster MultiVerse handler missing');
});
section('features');
test('Study Sessions command surface remains wired', () => {
  const bg = read('background.js'), popup = read('popup.js');
  for (const type of ['blbSuiteStartStudyTopic','blbSuiteStopStudyRecording','blbSuiteAddStudyNoteToTopic','blbSuiteUpdateStudyNoteToTopic','blbSuiteStudyTopicHistory','blbSuiteStudyTopicMultiVerse','blbSuiteOpenStrongHistory','blbSuiteOpenHistorySearchTerms']) {
    assert(bg.includes(type), `background Study Sessions handler missing: ${type}`);
    assert(popup.includes(type), `popup Study Sessions caller missing: ${type}`);
  }
});
test('Study Sessions download paths remain wired', () => {
  const bg = read('background.js'), popup = read('popup.js');
  for (const type of ['blbSuiteDownloadStudyTopic','blbSuiteDownloadStudyWhole','blbSuiteDownloadStudyDate']) {
    assert(bg.includes(type), `download handler missing: ${type}`);
    assert(popup.includes(type), `download caller missing: ${type}`);
  }
});
test('Omnibox command path remains wired', () => {
  const bg = read('background.js');
  assert(bg.includes('omnibox.onInputEntered'), 'omnibox listener missing');
  assert(bg.includes('handleOmniboxCommand'), 'omnibox handler missing');
  assert(bg.includes('SEARCH_RANGES'), 'Criteria search ranges missing');
});
test('permission Allow/Deny/Re-Allow lifecycle remains wired', () => {
  const bg = read('background.js'), popup = read('popup.js');
  assert(bg.includes('permissions?.onAdded') || bg.includes('onAdded?.addListener'), 'permission-added activation missing');
  assert(bg.includes('permissions.contains'), 'permission detection missing');
  assert(bg.includes('permissions') && bg.includes('request'), 'permission request missing');
  assert(popup.includes('requestCurrentSiteAccess'), 'site-access request missing');
  assert(popup.includes('setPageButton(on)'), 'site feature enable/disable state missing');
  assert(popup.includes('sites[state.siteKey] = !!on'), 'site feature state persistence missing');
});
test('reload/new-tab persistence and dynamic activation remain wired', () => {
  const bg = read('background.js'), content = read('content.js');
  assert(bg.includes('chrome.runtime.onStartup'), 'startup handling missing');
  assert(bg.includes('chrome.tabs.onUpdated'), 'navigation activation missing');
  assert(bg.includes('chrome.storage.onChanged'), 'storage activation missing');
  assert(content.includes('chrome.storage.onChanged'), 'content persistence listener missing');
});
test('popup exposes all core feature controls', () => {
  const popup = read('popup.js');
  for (const control of ['master','pageButton','doubleClick','redirectEnabled']) {
    assert(popup.includes("getElementById('" + control + "')") || popup.includes('getElementById("' + control + '")'), 'popup control missing: ' + control);
  }
});
section('selection');
test('reference classification retains all major selection types', () => {
  const bg = read('background.js');
  for (const type of ['STRONG','REFERENCE','BOOK','KJV_WORD','KJV_PHRASE','KJV_PASSAGE','KJV_REFERENCE_RANGE','REFERENCE_AND_KJV_PASSAGE','NON_KJV_SINGLE_WORD']) {
    assert(bg.includes("'" + type + "'") || bg.includes('"'+type+'"'), 'classifier type missing: ' + type);
  }
});

console.log(`\nGROUP: ${requestedGroup}\nRESULT: ${failures.length ? 'FAIL' : 'PASS'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f.name}: ${f.error}`);
  process.exitCode=1;
}