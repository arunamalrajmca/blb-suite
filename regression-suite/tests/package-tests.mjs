export function registerPackageTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
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
  assert(!m.host_permissions.includes('https://chatgpt.com/*'), 'ChatGPT access must not be required at install time');
});
test('content-script coverage includes web + local HTML/PDF', () => {
  const m = JSON.parse(read('manifest.json'));
  const matches = m.content_scripts?.flatMap(x=>x.matches||[]) || [];
  for (const expected of ['file:///*.pdf','file:///*.html','file:///*.htm']) assert(matches.includes(expected), expected);
  assert(!matches.includes('http://*/*') && !matches.includes('https://*/*'), 'arbitrary HTTP/HTTPS hosts must not be permanent content-script matches');
});
test('page-selection module load order is explicit in manifest and runtime injection', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(item => item.js || []);
  const background = read('background.js');
  const runtimeFilesStart = background.indexOf('const BLB_CONTENT_SCRIPT_FILES = [');
  const runtimeFilesEnd = background.indexOf('\n];', runtimeFilesStart);
  assert(runtimeFilesStart >= 0 && runtimeFilesEnd > runtimeFilesStart, 'runtime content-script list missing');
  const runtimeFiles = background.slice(runtimeFilesStart, runtimeFilesEnd);
  for (const list of [scripts.join('\n'), runtimeFiles.replace(/\/\/.*$/gm, '')]) {
    assert(list.includes('blb-page-selection-button.js'), 'page-selection module missing from script list');
    assert(list.indexOf('blb-page-selection-button.js') < list.indexOf('content.js'), 'page-selection module must load before content.js');
  }
  assert(read('blb-page-selection-button.js').includes('global.BLBPageSelectionButtonModule = { initialize }'), 'page-selection module registration missing');
});

test('MultiVerse hand-off module loads before content and retains pending-reference safeguards', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(item => item.js || []);
  const background = read('background.js');
  const runtimeStart = background.indexOf('const BLB_CONTENT_SCRIPT_FILES = [');
  const runtimeEnd = background.indexOf('\n];', runtimeStart);
  assert(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'runtime content-script list missing');
  const runtimeFiles = background.slice(runtimeStart, runtimeEnd).replace(/\/\/.*$/gm, '');
  for (const list of [scripts.join('\n'), runtimeFiles]) {
    assert(list.includes('multiverse-handoff.js'), 'MultiVerse hand-off module missing from script list');
    assert(list.indexOf('multiverse-handoff.js') < list.indexOf('content.js'), 'MultiVerse hand-off must load before content.js');
  }
  const handoff = read('multiverse-handoff.js');
  assert(handoff.includes('global.BLBMultiVerseHandoffModule = { initialize }'), 'MultiVerse hand-off module registration missing');
  assert(handoff.includes('blbSuiteGetPendingMultiVerseRefs') && handoff.includes('blbSuiteConsumePendingMultiVerseRefs'), 'pending MultiVerse reference hand-off is incomplete');
  assert(handoff.includes('blbSuiteMultiVersePending') && handoff.includes('waitForExpectedMultiVerseResults'), 'MultiVerse page must remain hidden until expected results are visible');
});

test('source Bible redirect module loads before content and preserves explicit dependencies', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(item => item.js || []);
  const background = read('background.js');
  const runtimeStart = background.indexOf('const BLB_CONTENT_SCRIPT_FILES = [');
  const runtimeEnd = background.indexOf('\n];', runtimeStart);
  assert(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'runtime content-script list missing');
  const runtimeFiles = background.slice(runtimeStart, runtimeEnd).split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  for (const list of [scripts.join('\n'), runtimeFiles]) {
    assert(list.includes('source-bible-redirect.js'), 'source Bible redirect module missing from script list');
    assert(list.indexOf('source-bible-redirect.js') < list.indexOf('content.js'), 'source Bible redirect module must load before content.js');
  }
  const module = read('source-bible-redirect.js');
  assert(module.includes('global.BLBSourceBibleRedirectModule = { initialize }'), 'source Bible redirect module registration missing');
  for (const dependency of ['parseChristianityBibleLink', 'validateSourceBibleReference', 'parseRef', 'decodeSafe', 'blbUrl', 'openBlbDestinationFromContent']) {
    assert(module.includes(dependency), 'source Bible redirect dependency missing: ' + dependency);
  }
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

test('Rediscover, Sagacity, and TSK use the existing nested-page MultiVerse collector', () => {
  const collector = read('source-page-collector.js');
  const registry = read('source-page-collector-sites.js');
  assert(/"rediscover\.bible"\s*:\s*\{\s*id:\s*"rediscover"/.test(registry));
  assert(/"sagacityweb\.com"\s*:\s*\{\s*id:\s*"sagacity"/.test(registry));
  assert(/"thetreasuryofscriptureknowledge\.com"\s*:\s*\{\s*id:\s*"treasury"/.test(registry));
  assert(collector.includes('BLBSourcePageCollectorSites?.[host]?.id'), 'collector must use the shared site registry metadata');
  assert(collector.includes('if (sourceSite && !isSourceHomepage)'));
  assert(collector.includes('document.querySelectorAll("a[href]")'));
  assert(collector.includes('if (sourceSite === "sagacity")'), 'Sagacity links must prefer the linked BLB citation over malformed/nested captions');
  assert(collector.includes('targetUrl.searchParams.get("Criteria")'), 'Sagacity links must recover the full citation from BLB Criteria');
  assert(collector.includes('targetHost === "blueletterbible.org"'), 'Criteria extraction must be restricted to BLB links');
  assert(collector.includes('/^\\/search\\/preSearch\.cfm$/i.test(targetUrl.pathname)'), 'Criteria extraction must be limited to the BLB preSearch endpoint');
  assert(collector.includes('String(targetUrl.searchParams.get("Criteria") || "").replace(/\\+/g, " ")'), 'plus signs in BLB Criteria must decode to spaces');
  const background = read('background.js');
  assert(background.includes("'source-page-collector-sites.js'"), 'background must import the shared collector registry');
  assert(background.includes('BLBSourcePageCollectorSites || {}'), 'runtime injection must consult the shared collector registry');
  assert(background.includes('collectorConfig?.mainWorldClickGuard === true'), 'optional MAIN-world click guards must come from shared registry metadata');
});

test('Rediscover, Sagacity, and TSK use optional access and dynamic injection only', () => {
  const m = JSON.parse(read('manifest.json'));
  const matches = m.content_scripts?.flatMap(x=>x.matches||[]) || [];
  for (const host of ['rediscover.bible','www.rediscover.bible','sagacityweb.com','www.sagacityweb.com','thetreasuryofscriptureknowledge.com','www.thetreasuryofscriptureknowledge.com']) {
    assert(!m.host_permissions.includes(`https://${host}/*`), `${host} must not become a required host permission`);
    assert(!matches.includes(`https://${host}/*`), `${host} must not become a permanent content-script match`);
  }
  assert(m.optional_host_permissions.includes('https://*/*'), 'existing optional HTTPS access must remain available');
});

test('Ask AI omnibox feature and ChatGPT host permission are removed', () => {
  const m = JSON.parse(read('manifest.json'));
  const source = read('background.js');
  assert(!m.optional_host_permissions.includes('https://chatgpt.com/*'), 'ChatGPT host permission must be removed');
  assert(!source.includes('askai'), 'Ask AI command parser and handler must be removed');
  assert(!source.includes('chatgpt.com'), 'ChatGPT composer injection and navigation must be removed');
});

// Syntax checks for all JS source files.
test('all JavaScript source files parse', () => {
  for (const f of fs.readdirSync(ROOT).filter(x=>x.endsWith('.js'))) {
    try {
      new vm.Script(read(f), {filename:f});
    } catch (error) {
      throw new Error(`${f}: ${error.message}`);
    }
  }
});


}
