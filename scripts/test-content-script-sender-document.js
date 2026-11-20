#!/usr/bin/env node
/**
 * Sender-document authorization regression tests.
 *
 * Modern web documents are validated by Chrome's current top-frame documentId,
 * not by URL snapshots that can temporarily disagree during navigation.
 * Browser-managed documents and older Chromium without documentId retain the
 * URL-based fallback.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
const start = background.indexOf('function sameSenderDocumentUrl(left, right) {');
const end = background.indexOf('\nfunction contentScriptSenderDocumentId(sender)', start);
assert.ok(start >= 0 && end > start, 'sender-document helpers must remain a bounded source section');
const source = background.slice(start, end);

function createHarness({liveTab, currentDocumentId, pdfViewer = false}) {
  let executeScriptCalls = 0;
  const sandbox = {
    URL,
    isPdfViewerTab: tab => !!tab?.isPdfViewer || pdfViewer,
    chrome: {
      runtime: {getURL: () => 'chrome-extension://suite/'},
      tabs: {get: async () => liveTab},
      scripting: {
        executeScript: async () => {
          executeScriptCalls++;
          return [{documentId:currentDocumentId, result:true}];
        }
      }
    }
  };
  vm.runInNewContext(source + '\nglobalThis.__checkSender = isLiveContentScriptSenderDocument;', sandbox);
  return {
    check: sender => sandbox.__checkSender(sender),
    get executeScriptCalls() { return executeScriptCalls; }
  };
}

(async () => {
  const modernSender = {
    tab:{id:7, url:'https://example.test/old-snapshot'},
    frameId:0,
    documentId:'doc-current',
    url:'https://example.test/sender-snapshot'
  };

  // URL snapshots may disagree in either direction, but a matching current
  // browser document ID authorizes the live top-frame document.
  const modernMatch = createHarness({
    liveTab:{id:7, url:'https://example.test/live-tab-url'},
    currentDocumentId:'doc-current'
  });
  assert.equal(await modernMatch.check(modernSender), true,
    'matching documentId is accepted despite stale sender/tab URL snapshots');
  assert.equal(modernMatch.executeScriptCalls, 1,
    'modern web sender is checked against the current top-frame document');

  const staleDocument = createHarness({
    liveTab:{id:7, url:'https://example.test/live'},
    currentDocumentId:'doc-new'
  });
  assert.equal(await staleDocument.check(modernSender), false,
    'a sender from a previous document is rejected even if it remains scriptable');

  const noDocumentIdMatch = createHarness({
    liveTab:{id:7, url:'https://example.test/page?x=1#live'}
  });
  assert.equal(await noDocumentIdMatch.check({
    tab:{id:7}, frameId:0, url:'https://example.test/page?x=1#sender'
  }), true, 'older Chromium falls back to URL identity while ignoring fragments');

  const noDocumentIdMismatch = createHarness({
    liveTab:{id:7, url:'https://example.test/new-page'}
  });
  assert.equal(await noDocumentIdMismatch.check({
    tab:{id:7}, frameId:0, url:'https://example.test/old-page'
  }), false, 'older Chromium rejects a sender whose document URL is no longer current');

  const fileMatch = createHarness({
    liveTab:{id:7, url:'file:///C:/docs/bible.pdf'}
  });
  assert.equal(await fileMatch.check({
    tab:{id:7, url:'file:///C:/docs/bible.pdf'}, frameId:0,
    url:'file:///C:/docs/bible.pdf'
  }), true, 'file documents retain URL-based live-document validation');

  const fileMismatch = createHarness({
    liveTab:{id:7, url:'file:///C:/docs/other.pdf'}
  });
  assert.equal(await fileMismatch.check({
    tab:{id:7, url:'file:///C:/docs/bible.pdf'}, frameId:0,
    url:'file:///C:/docs/bible.pdf'
  }), false, 'file documents reject stale URL identity');

  const subframe = createHarness({liveTab:{id:7, url:'https://example.test/'}});
  assert.equal(await subframe.check({...modernSender, frameId:2}), false,
    'subframe senders are rejected before current-document probing');
  assert.equal(subframe.executeScriptCalls, 0,
    'subframe rejection does not execute a top-frame probe');

  console.log('Sender-document authorization regression tests passed.');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
