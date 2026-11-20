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
const pageSelectionButton = read('extension/blb-page-selection-button.js');
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

  // Startup selection contracts: Double-click must have a capture listener
  // before asynchronous master/per-site settings reads finish, and the event
  // handler must defer authorization until those settings are authoritative.
  has(contentScript, /if \(location\.hostname !== BLB_HOSTNAME && !isSensitiveSiteUrl\(location\.href\)\) \{\s*enableDoubleClickBlb\(\);\s*\}\s*void ensureDoubleClickSettingsReady\(\);/,
    'Double-click listener is armed before initial settings readiness');
  has(contentScript, /if \(!suiteSettingsReady \|\| !doubleClickSettingsReady\) \{[\s\S]{0,260}ensureDoubleClickSettingsReady\(\)\.then\([\s\S]{0,220}handleDoubleClickBlb\(event\)/,
    'early Double-click events wait for authoritative settings before dispatch');

  // Chromium groups multiple extension context-menu entries into a submenu.
  // Keep exactly one registered native selection item and choose web/PDF
  // eligibility from the active tab rather than creating a second item.
  has(background, /async function shouldShowSelectionContextMenu\(tab, selectionText = ''\)/,
    'one tab-aware selection-menu eligibility path serves web and PDF pages');
  const registeredSelectionMenuIds = [...background.matchAll(/chrome\.contextMenus\.create\(\{[\s\S]{0,320}?id:\s*['"]([^'"]+)['"]/g)]
    .map(match => match[1]);
  assert.deepEqual(registeredSelectionMenuIds, ['blb-suite-web-selection'],
    'only one native selection context-menu item may be registered');

  // MultiVerse page handoff contract: read refs, verify the rendered input,
  // consume only after verification, and retain the background-owned POST slot.
  ordered(multiverseHandoffModule, [
    [/blbSuiteGetPendingMultiVerseRefs/, 'pending-reference read'],
    [/actual\s*=\s*String\(primary\.value/, 'rendered input verification'],
    [/await consumePendingMultiVerseRefs\(\)/, 'pending-reference consume after successful verification']
  ], 'MultiVerse handoff reads, verifies, then consumes pending references');
  has(multiverseHandoffModule, /async function consumePendingMultiVerseRefs/, 'MultiVerse handoff has a dedicated pending-reference retry helper');
  has(multiverseHandoffModule, /blbSuiteConsumePendingMultiVerseRefs/, 'MultiVerse handoff consumes pending references through the background API');
  has(background, /blbSuiteGetPendingMultiVerseRefs/, 'background exposes pending MultiVerse references');
  has(background, /blbSuiteConsumePendingMultiVerseRefs/, 'background exposes pending MultiVerse consumption');
  has(background, /blbSuiteAcquireMultiVersePostSlot/, 'background owns MultiVerse POST scheduling');
  has(handoff, /blbSuiteAcquireMultiVersePostSlot/, 'handoff page acquires its background POST slot');
  has(handoff, /blbSuiteMultiVerseHandoffTiming/, 'handoff timing diagnostics use the shared message contract');

  // Selection/settings boundary: background resolves contextual selections,
  // content serves the request, and popup settings use the same background API.
  has(background, /type:\s*['"]blbSuiteResolveContextualSelection['"]/, 'background requests contextual selection resolution');
  has(pageSelectionButton, /message\?\.type === ['"]blbSuiteResolveContextualSelection['"]/, 'page-selection module handles contextual selection resolution');
  has(background, /type:\s*['"]blbSuiteRefreshSiteFeatures['"]/, 'background refreshes content-script site features');
  has(pageSelectionButton, /message\?\.type === ['"]blbSuiteRefreshSiteFeatures['"]/, 'page-selection module handles feature refresh requests');
  has(popup, /type:\s*['"]blbSuitePrepareSiteFeatureToggle['"]/, 'popup routes per-site toggles through the background policy');
  has(background, /message\.type === ['"]blbSuitePrepareSiteFeatureToggle['"]/, 'background validates per-site toggle requests');
  has(background, /isSensitiveSiteHostname\(originHost\)/, 'background blocks sensitive-site feature opt-ins');
  has(popup, /blbSuiteBeginRedirectToggle/, 'popup persists redirect intent through the worker before requesting access');
  has(popup, /blbSuiteCommitRedirectToggle/, 'popup conditionally commits redirect permission outcomes');
  has(background, /message\.type === ['"]blbSuiteBeginRedirectToggle['"]/, 'background records cross-popup redirect intent generations');
  has(background, /message\.type === ['"]blbSuiteCommitRedirectToggle['"]/, 'background rejects stale redirect permission outcomes');
  has(popup, /type:\s*['"]blbSuiteSetMasterEnabled['"]/, 'popup delegates global master transitions to the service worker');
  has(background, /message\.type === ['"]blbSuiteSetMasterEnabled['"]/, 'background serializes global master transitions across popup instances');
  has(background, /function runMasterToggle\(operation\)/, 'global master transitions share a service-worker queue');

  // Study Sessions are shared through message APIs; backup must remain scoped
  // to Study data, never silently restoring global/site settings.
  has(popup, /type:\s*['"]blbSuiteGetStudyUiState['"]/, 'popup retrieves Study Sessions state from background');
  has(background, /blbSuiteGetStudyUiState/, 'background retains Study Sessions state API');
  assert.doesNotMatch(background, /blbSuiteCaptureStudyNote|recordStudyNote\(/,
    'unreferenced Study note capture protocol must not remain in the background');
  console.log('PASS: obsolete Study note capture handler and recorder are absent');
  has(popup, /const STUDY_BACKUP_KEYS = \['studySessions', 'studyTopics', 'studySelectedTopic', 'studyAutoStopMinutes'\]/, 'Study backup has an explicit allowlist of Study-only storage keys');
  has(popup, /type:\s*['"]blbSuiteRestoreStudyBackup['"]/, 'popup delegates Study backup restoration to the background');
  has(background, /function restoreStudyBackupFromPopup\(\.\.\.args\) \{\s*return runStudyMutation/, 'Study backup restoration shares the Study mutation queue');
  has(background, /chrome\.storage\.local\.get\(\{studySessions:\[\], studyTopics:\[\], currentStudySessionId:null\}\)/, 'Study snapshots include the saved topic list before read-modify-write operations');
  has(background, /message\.type === ['"]blbSuiteRestoreStudyBackup['"]/, 'background retains the queued Study backup restore handler');
  has(background, /entries\[feature\]\?\.requestId !== message\.requestId/, 'late permission grants cannot commit superseded site choices');
  assert.doesNotMatch(popup.match(/const STUDY_BACKUP_KEYS = \[[^\]]*\]/)?.[0] || '', /masterEnabled|pageSelectionButtonSites|doubleClickBlbSites|redirectEnabled/, 'Study backup must not include global/site settings');
  console.log('PASS: Study backup excludes extension-wide and per-site settings');

  // Every explicit branch inside the general async router must be admitted
  // by its allowlist. This prevents a handler from existing in source while
  // remaining unreachable because its message type was omitted from the set.
  const asyncRouterStart = background.indexOf(
    "if (!message || !ASYNC_MESSAGE_TYPES.has(message.type)) return false;"
  );
  const asyncRouterEnd = background.indexOf("// Keep the original BLB /net fallback", asyncRouterStart);
  const allowlistStart = background.indexOf("const ASYNC_MESSAGE_TYPES = new Set([");
  const allowlistEnd = background.indexOf("]);", allowlistStart);
  assert.ok(asyncRouterStart >= 0 && asyncRouterEnd > asyncRouterStart,
    'general async message router must retain a bounded, identifiable handler block');
  assert.ok(allowlistStart >= 0 && allowlistEnd > allowlistStart,
    'general async message router must retain its explicit allowlist');
  const allowedMessageTypes = new Set([...background.slice(allowlistStart, allowlistEnd)
    .matchAll(/["']([^"']+)["']/g)].map(match => match[1]));
  const routedMessageTypes = [...background.slice(asyncRouterStart, asyncRouterEnd)
    .matchAll(/message(?:\?\.)?\.type\s*(?:===|!==)\s*["']([^"']+)["']/g)]
    .map(match => match[1]);
  assert.ok(routedMessageTypes.length > 0, 'general async message router must expose explicit message branches');
  const unregisteredMessageTypes = [...new Set(routedMessageTypes)]
    .filter(type => !allowedMessageTypes.has(type));
  assert.deepEqual(unregisteredMessageTypes, [],
    'every explicit message branch in the general async router must be allowlisted');
  console.log('PASS: all general async message branches are registered in the allowlist');

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
