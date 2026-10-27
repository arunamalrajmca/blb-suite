const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const manifestPath = path.join(ext, 'manifest.json');
const packagePath = path.join(root, 'package.json');

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS:', msg); }

if (!fs.existsSync(manifestPath)) {
  fail('extension/manifest.json missing');
} else {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = m.version;
  if (!version) fail('manifest version missing'); else pass(`manifest version ${version}`);

  if (!fs.existsSync(packagePath)) {
    fail('package.json missing');
  } else {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (pkg.version !== version) fail(`package.json version ${pkg.version} != manifest ${version}`);
    else pass(`package.json version matches manifest ${version}`);
  }

  if (!(m.permissions || []).includes('tabs')) fail('tabs permission missing');
  else pass('tabs permission present');

  // Broad website access and ChatGPT access are intentionally optional.
  // Keep only BLB as a required host; site features request optional access
  // after the user enables them, and Ask AI requests ChatGPT access on demand.
  const hosts = m.host_permissions || [];
  if (hosts.includes('http://*/*') || hosts.includes('https://*/*')) {
    fail('broad wildcard host access must remain optional');
  } else if (!hosts.includes('https://www.blueletterbible.org/*')) {
    fail('required Blue Letter Bible host permission missing');
  } else {
    pass('required host access is limited to Blue Letter Bible');
  }

  const optionalHosts = m.optional_host_permissions || [];
  for (const pattern of ['http://*/*', 'https://*/*', 'https://chatgpt.com/*']) {
    if (optionalHosts.includes(pattern)) pass(`optional host permission present: ${pattern}`);
    else fail(`optional host permission missing: ${pattern}`);
  }

  const matches = (m.content_scripts || []).flatMap(x => x.matches || []);
  if (matches.some(x => x === 'http://*/*' || x === 'https://*/*')) {
    fail('broad wildcard content-script matches must not bypass the optional-site access model');
  } else {
    pass('no broad wildcard declarative content-script matches');
  }
}

const jsFiles = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.js')) jsFiles.push(p);
  }
}
walk(ext);

for (const file of jsFiles) {
  const r = cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) fail('syntax: ' + path.relative(root, file) + '\n' + r.stderr);
}
if (!process.exitCode) pass(jsFiles.length + ' JavaScript files parse successfully');

const source = jsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
for (const s of ['chrome.permissions.request', 'chrome.permissions.contains', 'chrome.permissions.onAdded', 'chrome.scripting.executeScript']) {
  const present = s === 'chrome.permissions.onAdded'
    ? source.includes('chrome.permissions?.onAdded?.addListener') || source.includes('chrome.permissions.onAdded.addListener')
    : source.includes(s);
  if (present) pass('architecture API present: ' + s);
  else fail('architecture API missing: ' + s);
}


// User-guide assets and popup entry point must stay HTML-only; the retired PDF
// must not return through a stale popup link or regression fixture.
const popupPath = path.join(ext, 'popup.html');
const guidePath = path.join(ext, 'Tutorial.html');
const guidePdfPath = path.join(ext, 'Tutorial.pdf');
if (!fs.existsSync(guidePath)) fail('Tutorial.html missing');
else pass('HTML user guide present');
if (fs.existsSync(guidePdfPath)) fail('retired extension/Tutorial.pdf must not be packaged');
else pass('retired Tutorial.pdf absent');
if (fs.existsSync(popupPath)) {
  const popup = fs.readFileSync(popupPath, 'utf8');
  const popupScript = fs.readFileSync(path.join(ext, 'popup.js'), 'utf8');
  if (!popup.includes('id="extensionVersion"') || !popup.includes('KJV Scripture Tools')) fail('popup must show the extension version below KJV Scripture Tools');
  else pass('popup version link is present below KJV Scripture Tools');
  if (/Feature Guide|guidePdf|Tutorial\.pdf/i.test(popup + '\n' + popupScript)) fail('retired PDF guide UI/code reference remains');
  else pass('no retired PDF guide UI/code references');
}

const moduleContractTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-module-loading-contracts.js')
], { encoding: 'utf8' });
if (moduleContractTest.stdout) process.stdout.write(moduleContractTest.stdout);
if (moduleContractTest.status !== 0) {
  fail('module-loading contract checks failed\\n' + (moduleContractTest.stderr || ''));
} else {
  pass('module-loading and shared-reference contracts validated');
}

const routingContractTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-ci-routing-selector.js')
], { encoding: 'utf8' });
if (routingContractTest.stdout) process.stdout.write(routingContractTest.stdout);
if (routingContractTest.status !== 0) {
  fail('CI routing selector contract checks failed\\n' + (routingContractTest.stderr || ''));
} else {
  pass('CI routing selector decisions validated against synthetic diffs');
}

const crossFeatureContractTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-cross-feature-contracts.js')
], { encoding: 'utf8' });
if (crossFeatureContractTest.stdout) process.stdout.write(crossFeatureContractTest.stdout);
if (crossFeatureContractTest.status !== 0) {
  fail('cross-feature integration contract checks failed\\n' + (crossFeatureContractTest.stderr || ''));
} else {
  pass('cross-feature integration contracts validated');
}

const omniboxGibberishFilterTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-omnibox-gibberish-filter.js')
], { encoding: 'utf8' });
if (omniboxGibberishFilterTest.stdout) process.stdout.write(omniboxGibberishFilterTest.stdout);
if (omniboxGibberishFilterTest.status !== 0) {
  fail('Omnibox gibberish-filter tests failed\\n' + (omniboxGibberishFilterTest.stderr || ''));
} else {
  pass('Omnibox gibberish-filter contracts validated');
}

const omniboxBooleanOperatorsTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-omnibox-boolean-operators.js')
], { encoding: 'utf8' });
if (omniboxBooleanOperatorsTest.stdout) process.stdout.write(omniboxBooleanOperatorsTest.stdout);
if (omniboxBooleanOperatorsTest.status !== 0) {
  fail('Omnibox Boolean operator tests failed\\n' + (omniboxBooleanOperatorsTest.stderr || ''));
} else {
  pass('Omnibox Boolean operator contracts validated');
}

const omniboxNormalizationTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-omnibox-search-normalization.js')
], { encoding: 'utf8' });
if (omniboxNormalizationTest.stdout) process.stdout.write(omniboxNormalizationTest.stdout);
if (omniboxNormalizationTest.status !== 0) {
  fail('Omnibox search normalization tests failed\\n' + (omniboxNormalizationTest.stderr || ''));
} else {
  pass('Omnibox search normalization contracts validated');
}

const extractionSafetyTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-extraction-safety-contracts.js')
], { encoding: 'utf8' });
if (extractionSafetyTest.stdout) process.stdout.write(extractionSafetyTest.stdout);
if (extractionSafetyTest.status !== 0) {
  fail('extraction safety contract checks failed\\n' + (extractionSafetyTest.stderr || ''));
} else {
  pass('manifest, dependency order, and module registration safety validated');
}

const selectionTextNormalizationTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-selection-text-normalization.js')
], { encoding: 'utf8' });
if (selectionTextNormalizationTest.stdout) process.stdout.write(selectionTextNormalizationTest.stdout);
if (selectionTextNormalizationTest.status !== 0) {
  fail('selection-text normalization tests failed\\n' + (selectionTextNormalizationTest.stderr || ''));
} else {
  pass('selection-text normalization contracts validated');
}

const selectionMarkerStrippingTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-selection-marker-stripping.js')
], { encoding: 'utf8' });
if (selectionMarkerStrippingTest.stdout) process.stdout.write(selectionMarkerStrippingTest.stdout);
if (selectionMarkerStrippingTest.status !== 0) {
  fail('selection-marker stripping tests failed\\n' + (selectionMarkerStrippingTest.stderr || ''));
} else {
  pass('selection-marker stripping contracts validated');
}

const singleWordSelectionNormalizationTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-single-word-selection-normalization.js')
], { encoding: 'utf8' });
if (singleWordSelectionNormalizationTest.stdout) process.stdout.write(singleWordSelectionNormalizationTest.stdout);
if (singleWordSelectionNormalizationTest.status !== 0) {
  fail('single-word selection normalization tests failed\\n' + (singleWordSelectionNormalizationTest.stderr || ''));
} else {
  pass('single-word selection normalization contracts validated');
}

const multiVerseReferenceTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-multiverse-reference-helpers.js')
], { encoding: 'utf8' });
if (multiVerseReferenceTest.stdout) process.stdout.write(multiVerseReferenceTest.stdout);
if (multiVerseReferenceTest.status !== 0) {
  fail('MultiVerse reference helper tests failed\\n' + (multiVerseReferenceTest.stderr || ''));
} else {
  pass('MultiVerse reference helper contracts validated');
}

const studySessionExportTest = cp.spawnSync(process.execPath, [
  path.join(__dirname, 'test-study-session-export.js')
], { encoding: 'utf8' });
if (studySessionExportTest.stdout) process.stdout.write(studySessionExportTest.stdout);
if (studySessionExportTest.status !== 0) {
  fail('Study Sessions export contract tests failed\\n' + (studySessionExportTest.stderr || ''));
} else {
  pass('Study Sessions export contracts validated');
}
