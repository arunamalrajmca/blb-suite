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
const expectedVersion = process.env.BLB_EXPECTED_VERSION || fixture.baselineVersion;
const failures = [];
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failures.push({name, error:e.message}); console.log(`✗ ${name}\n  ${e.message}`); }
}
function read(name){ return fs.readFileSync(path.join(ROOT,name),'utf8'); }
function sha256(file){ return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex'); }
function loadPure(files){
  const ctx = vm.createContext({console, Set, Map, Object, Number, String, Array, Math, RegExp, JSON, window:{}}); ctx.self = ctx;
  for (const file of files) vm.runInContext(read(file), ctx, {filename:file});
  return ctx;
}

console.log(`BLB Suite Regression Suite — baseline ${fixture.baselineVersion} | expected package ${expectedVersion}`);
console.log(`Package: ${ROOT}\n`);

// Manifest/package invariants.
test('manifest JSON + MV3 + version', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, expectedVersion);
  assert.equal(m.background?.service_worker, 'background.js');
});
test('required HTTP/HTTPS host permissions', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.deepEqual(m.host_permissions, ['http://*/*','https://*/*']);
});
test('content-script coverage includes web + local HTML/PDF', () => {
  const m = JSON.parse(read('manifest.json'));
  const matches = m.content_scripts?.flatMap(x=>x.matches||[]) || [];
  for (const expected of ['http://*/*','https://*/*','file:///*.pdf','file:///*.html','file:///*.htm']) assert(matches.includes(expected), expected);
});
test('manifest-referenced files exist', () => {
  const m = JSON.parse(read('manifest.json'));
  const refs = [m.background?.service_worker, m.options_page, ...(m.content_scripts||[]).flatMap(x=>x.js||[]), ...Object.values(m.icons||{}), m.action?.default_popup].filter(Boolean);
  for (const f of refs) assert(fs.existsSync(path.join(ROOT,f)), `missing ${f}`);
});
test('no optional host-permission regression', () => {
  const m = JSON.parse(read('manifest.json'));
  assert(!('optional_host_permissions' in m), 'optional_host_permissions must not replace required host access');
});

// Syntax checks for all JS source files.
test('all JavaScript source files parse', () => {
  for (const f of fs.readdirSync(ROOT).filter(x=>x.endsWith('.js'))) {
    new vm.Script(read(f), {filename:f});
  }
});

// Shared Bible-reference core + production selection extractor.
const refCtx = loadPure(['books.js','book-aliases.js','reference-core.js']);
const bgSource = read('background.js');
const extractorStart = bgSource.indexOf('function extractBibleRefsFromSelectedTextUncached');
const extractorEnd = bgSource.indexOf('\nfunction ', extractorStart + 10);
vm.runInContext(bgSource.slice(extractorStart, extractorEnd > extractorStart ? extractorEnd : undefined), refCtx, {filename:'background.js:extractBibleRefsFromSelectedTextUncached'});

test('shared core resolves numbered references', () => {
  for (const c of fixture.references.slice(1)) {
    const numeric = c.input.replace(/^I /,'1 ').replace(/^II /,'2 ').replace(/^III /,'3 ');
    const refs = refCtx.resolveBibleReferenceText(numeric);
    assert.equal(refs.length,1,numeric);
    const r=refs[0];
    assert.equal(r.book,c.book,numeric);
    assert.equal(r.chapter,c.chapter,numeric);
    assert.equal(r.from,c.from,numeric);
    assert.equal(r.to,c.to,numeric);
  }
});
test('production selection extractor resolves Roman numeral books', () => {
  for (const c of fixture.references) {
    const refs = refCtx.extractBibleRefsFromSelectedTextUncached(c.input);
    assert.equal(refs.length,1,c.input);
    const r=refs[0];
    assert.equal(r.book,c.book,c.input);
    assert.equal(r.chapter,c.chapter,c.input);
    assert.equal(r.from,c.from,c.input);
    assert.equal(r.to,c.to,c.input);
  }
});
test('five-reference paragraph extraction', () => {
  const refs = refCtx.extractBibleRefsFromSelectedTextUncached(fixture.multiReferenceText);
  const got = refs.map(r=>`${r.book}|${r.chapter}|${r.from}|${r.to}`);
  const expected = [
    'john|1|1|1','hebrews|10|7|7','1 timothy|6|15|15','colossians|1|16|16','philippians|2|10|10'
  ];
  assert.equal(JSON.stringify(got), JSON.stringify(expected));
});
test('direct reference resolver rejects prose and accepts exact refs', () => {
  assert(refCtx.resolveDirectBibleReference('1 Thessalonians 2:13'));
  assert.equal(refCtx.resolveDirectBibleReference('in every one'), null);
  // Roman numeral handling belongs to the production selection extractor, not the pure core.
  assert(refCtx.extractBibleRefsFromSelectedTextUncached('I Thessalonians 2:13').length === 1);
});

// Case-sensitive core + corpus.
const csCtx = loadPure(['case-sensitive-search-core.js','kjv-corpus-original-case.js','kjv-corpus-case-verse-index.js']);
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

// Static cross-file contracts for high-risk regressions.
const bg=read('background.js');
const content=read('content.js');
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
test('case-sensitive URL-builder failure has native fallback', () => {
  const start=bg.indexOf('const urls=buildCaseSensitiveMultiVerseUrls');
  const end=bg.indexOf('await openCaseSensitiveDestinations',start);
  const section=bg.slice(start,end);
  assert(section.includes('openCaseSensitiveNativeSearch(parsed.rawQuery, disposition)'));
});

test('expected PDF limitation remains documented by test policy', () => {
  assert.equal(fixture.pdfPolicy,'expected-limitation');
});

test('external redirect coverage includes every supported redirect host', () => {
  const content = read('content.js');
  for (const host of ['bible.com','biblegateway.com','bibleref.com','biblehub.com','kingjamesbibleonline.org','kjbo.org','kjv.site','officialkingjamesbible.com','bibleportal.com','webstersdictionary1828.com','blueletterbible.org']) assert(content.includes(host), `redirect host missing: ${host}`);
  assert(content.includes('function redirectBibleSite'), 'Bible-site redirect parser missing');
  assert(content.includes('function redirectBlbNet'), 'BLB NET redirect missing');
  assert(content.includes('const REDIRECT_HOSTS'), 'redirect host table missing');
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
test('MultiVerse creation/reuse path remains wired', () => {
  const bg = read('background.js');
  assert(bg.includes('createBlbTabGeneric'), 'BLB tab manager missing');
  assert(bg.includes('openSelectedPdfBibleRefs'), 'shared MultiVerse/reference opener missing');
  assert(bg.includes('createBlbTabGeneric'), 'MultiVerse tab creation/reuse missing');
});
test('Webster 1828 path remains wired', () => {
  const content = read('content.js'), bg = read('background.js');
  assert(content.includes('webstersdictionary1828.com'), 'Webster host missing');
  assert(content.includes('collectWebsterBibleRefs'), 'Webster collector missing');
  assert(content.includes('blbSuiteOpenBackgroundUrl'), 'Webster opener missing');
  assert(bg.includes('blbSuiteOpenWebsterMultiVerse'), 'Webster MultiVerse handler missing');
});
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
  assert(bg.includes('permissions.request'), 'permission request missing');
  assert(bg.includes('permissions.remove'), 'permission removal missing');
  assert(popup.includes('requestCurrentSiteAccess'), 'site-access request missing');
});
test('reload/new-tab persistence and dynamic activation remain wired', () => {
  const bg = read('background.js'), content = read('content.js');
  assert(bg.includes('chrome.runtime.onStartup'), 'startup handling missing');
  assert(bg.includes('webNavigation') && bg.includes('onCommitted'), 'navigation activation missing');
  assert(bg.includes('chrome.storage.onChanged'), 'storage activation missing');
  assert(content.includes('chrome.storage.onChanged'), 'content persistence listener missing');
});
test('popup exposes all core feature controls', () => {
  const popup = read('popup.js');
  for (const control of ['master','pageButton','doubleClick','redirectEnabled']) {
    assert(popup.includes("getElementById('" + control + "')") || popup.includes('getElementById("' + control + '")'), 'popup control missing: ' + control);
  }
});
test('reference classification retains all major selection types', () => {
  const bg = read('background.js');
  for (const type of ['STRONG','REFERENCE','BOOK','KJV_WORD','KJV_PHRASE','KJV_PASSAGE','KJV_REFERENCE_RANGE','REFERENCE_AND_KJV_PASSAGE','NON_KJV_SINGLE_WORD']) {
    assert(bg.includes("'" + type + "'") || bg.includes('"'+type+'"'), 'classifier type missing: ' + type);
  }
});

console.log(`\nRESULT: ${failures.length ? 'FAIL' : 'PASS'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f.name}: ${f.error}`);
  process.exitCode=1;
}
