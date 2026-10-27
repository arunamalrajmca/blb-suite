#!/usr/bin/env node
/**
 * Cross-feature integration contracts for the staged module extraction.
 * These assertions protect the interfaces shared by content, background,
 * popup, and the MultiVerse handoff page without freezing function layout.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const contentScript = read('extension/content.js');
const background = read('extension/background.js');
const popup = read('extension/popup.js');
const handoff = read('extension/multiverse-post.js');
const multiverseHandoffModule = read('extension/multiverse-handoff.js');
const manifest = JSON.parse(read('extension/manifest.json'));

function has(source, pattern, description) {
  assert.match(source, pattern, description);
  console.log('PASS:', description);
}
function ordered(source, patterns, description) {
  let last = -1;
  for (const [pattern, label] of patterns) {
    const index = source.search(pattern);
    assert.notEqual(index, -1, description + ': missing ' + label);
    assert.ok(index > last, description + ': ' + label + ' must follow its predecessor');
    last = index;
  }
  console.log('PASS:', description);
}

try {
  // Both ends of the content-to-background tab/navigation bridge must retain
  // the same message name and its BLB-only destination guard.
  has(contentScript, /type:\s*['"]blbSuiteOpenBackgroundUrl['"]/, 'content script retains the background URL message');
  has(background, /message\.type === ['"]blbSuiteOpenBackgroundUrl['"]/, 'background retains the URL message handler');
  has(background, /!\(await isSuiteEnabled\(\)\)[\s\S]{0,180}sendResponse\(\{ok:false\}\)/, 'background URL navigation respects the global master switch');
  has(background, /https:\\\/\\\/www\\\.blueletterbible\\\.org\\\//, 'background URL navigation validates BLB destinations');

  // MultiVerse page handoff contract: read refs, verify the rendered input,
  // consume only after verification, and retain the background-owned POST slot.
  ordered(multiverseHandoffModule, [
    [/blbSuiteGetPendingMultiVerseRefs/, 'pending-reference read'],
    [/const actual\s*=\s*normalizeSelectionText\(/, 'rendered input verification'],
    [/blbSuiteConsumePendingMultiVerseRefs/, 'pending-reference consume']
  ], 'MultiVerse handoff reads, verifies, then consumes pending references');
  has(background, /blbSuiteGetPendingMultiVerseRefs/, 'background exposes pending MultiVerse references');
  has(background, /blbSuiteConsumePendingMultiVerseRefs/, 'background exposes pending MultiVerse consumption');
  has(background, /blbSuiteAcquireMultiVersePostSlot/, 'background owns MultiVerse POST scheduling');
  has(handoff, /blbSuiteAcquireMultiVersePostSlot/, 'handoff page acquires its background POST slot');
  has(handoff, /blbSuiteMultiVerseHandoffTiming/, 'handoff timing diagnostics use the shared message contract');

  // Selection/settings boundary: background resolves contextual selections,
  // content serves the request, and popup settings use the same background API.
  has(background, /type:\s*['"]blbSuiteResolveContextualSelection['"]/, 'background requests contextual selection resolution');
  has(contentScript, /message\?\.type === ['"]blbSuiteResolveContextualSelection['"]/, 'content script handles contextual selection resolution');
  has(background, /type:\s*['"]blbSuiteRefreshSiteFeatures['"]/, 'background refreshes content-script site features');
  has(contentScript, /message\?\.type === ['"]blbSuiteRefreshSiteFeatures['"]/, 'content script handles feature refresh requests');
  has(popup, /type:\s*['"]blbSuitePrepareSiteFeatureToggle['"]/, 'popup routes per-site toggles through the background policy');
  has(background, /message\.type === ['"]blbSuitePrepareSiteFeatureToggle['"]/, 'background validates per-site toggle requests');
  has(background, /isSensitiveSiteHostname\(originHost\)/, 'background blocks sensitive-site feature opt-ins');
  has(popup, /masterEnabled:on/, 'popup persists the global master switch');

  // Study Sessions are shared through message APIs; backup must remain scoped
  // to Study data, never silently restoring global/site settings.
  has(popup, /type:\s*['"]blbSuiteGetStudyUiState['"]/, 'popup retrieves Study Sessions state from background');
  has(background, /blbSuiteGetStudyUiState/, 'background retains Study Sessions state API');
  has(popup, /const STUDY_BACKUP_KEYS = \['studySessions', 'studyTopics', 'studySelectedTopic', 'studyAutoStopMinutes'\]/, 'Study backup has an explicit allowlist of Study-only storage keys');
  assert.doesNotMatch(popup.match(/const STUDY_BACKUP_KEYS = \[[^\]]*\]/)?.[0] || '', /masterEnabled|pageSelectionButtonSites|doubleClickBlbSites|redirectEnabled/, 'Study backup must not include global/site settings');
  console.log('PASS: Study backup excludes extension-wide and per-site settings');

  // Content-script dependency order is part of the integration contract:
  // reference-core must be available before content.js executes.
  const scripts = (manifest.content_scripts || []).flatMap(entry => entry.js || []);
  const referenceIndex = scripts.indexOf('reference-core.js');
  const contentIndex = scripts.indexOf('content.js');
  const kingsIndex = scripts.indexOf('kings-bible-collector.js');
  assert.ok(referenceIndex >= 0 && kingsIndex > referenceIndex && contentIndex > kingsIndex,
    'reference-core.js and the Kings Bible feature module must load before content.js');
  console.log('PASS: shared reference resolver and Kings Bible module load before content script');

  console.log('All cross-feature integration contracts passed.');
} catch (error) {
  console.error('FAIL: cross-feature integration contracts:', error.stack || error.message);
  process.exitCode = 1;
}
