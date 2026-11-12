const { test, expect } = require('./fixtures');

test.describe('PDF selection context-menu regressions', () => {
  test('recognizes local PDFs and browser PDF-viewer URLs without treating ordinary pages as PDFs', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(() => {
      const cases = [
        { tab: { url: 'file:///C:/Bible/notes.pdf', title: 'notes.pdf' }, key: '__blb_local_pdf__', pdf: true },
        { tab: { url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=file%3A%2F%2F%2FC%3A%2FBible%2Fnotes.pdf', title: 'PDF Viewer' }, key: '__blb_pdf_viewer__', pdf: true },
        { tab: { url: 'brave://pdf-internals/', title: 'PDF internals' }, key: '__blb_pdf_viewer__', pdf: true },
        { tab: { url: 'https://example.com/notes.pdf', title: 'Notes' }, key: 'example.com', pdf: false },
        { tab: { url: 'https://example.com/article', title: 'Article' }, key: 'example.com', pdf: false }
      ];
      return cases.map(({ tab, key, pdf }) => ({
        url: tab.url,
        key: pageSelectionSettingKeyFromTab(tab),
        expectedKey: key,
        isPdf: isPdfViewerTab(tab),
        expectedPdf: pdf
      }));
    });

    for (const item of result) {
      expect(item.key, item.url).toBe(item.expectedKey);
      expect(item.isPdf, item.url).toBe(item.expectedPdf);
    }
  });

  test('PDF menu visibility requires a PDF tab, master switch, and explicit Show on BLB preference', async ({ extensionWorker, extensionStorage }) => {
    await extensionStorage.clear();
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { '__blb_local_pdf__': true, '__blb_pdf_viewer__': true }
    });

    const result = await extensionWorker.evaluate(async () => {
      const originalUpdate = chrome.contextMenus.update;
      const originalKnownPresent = pdfSelectionMenuKnownPresent;
      const updates = [];
      try {
        pdfSelectionMenuKnownPresent = true;
        chrome.contextMenus.update = async (id, details) => {
          updates.push({ id, visible: details.visible });
        };

        const localPdf = { url: 'file:///C:/Bible/notes.pdf', title: 'notes.pdf' };
        const browserPdf = { url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=notes.pdf', title: 'PDF Viewer' };
        const ordinaryPage = { url: 'https://example.com/article', title: 'Article' };

        await syncPdfSelectionContextMenuVisibility(localPdf);
        await syncPdfSelectionContextMenuVisibility(browserPdf);
        await syncPdfSelectionContextMenuVisibility(ordinaryPage);

        await chrome.storage.local.set({ masterEnabled: false });
        await syncPdfSelectionContextMenuVisibility(localPdf);

        await chrome.storage.local.set({ masterEnabled: true, pageSelectionButtonSites: { '__blb_local_pdf__': false, '__blb_pdf_viewer__': true } });
        await syncPdfSelectionContextMenuVisibility(localPdf);

        return updates;
      } finally {
        chrome.contextMenus.update = originalUpdate;
        pdfSelectionMenuKnownPresent = originalKnownPresent;
      }
    });

    const pdfUpdates = result.filter(update => update.id === 'blb-suite-pdf-selection');
    expect(pdfUpdates.some(update => update.visible === true)).toBe(true);
    expect(pdfUpdates.at(-1).visible).toBe(false);
    expect(pdfUpdates.filter(update => update.visible === true).length).toBeGreaterThanOrEqual(2);
  });
});


test('local PDF context-menu handoff opens a selected full Bible reference through the PDF-safe path', async ({
  extensionWorker
}) => {
  const previous = await extensionWorker.evaluate(async () => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false
  }));
  const beforeTabs = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({})).map(tab => tab.id)
  );
  const sourceTabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );

  try {
    await extensionWorker.evaluate(async () => {
      await chrome.storage.local.set({
        masterEnabled:true,
        pageSelectionButtonSites:{'__blb_local_pdf__':true},
        doubleClickBlbSites:{},
        redirectEnabled:false
      });
    });

    const eligibility = await extensionWorker.evaluate(async tabId => {
      const pdfTab = {id:tabId,url:'file:///C:/Bible/notes.pdf',title:'notes.pdf'};
      return {
        siteKey:pageSelectionSettingKeyFromTab(pdfTab),
        menuVisible:await shouldShowBlbContextMenu(pdfTab,'John 3:16')
      };
    }, sourceTabId);
    expect(eligibility.siteKey).toBe('__blb_local_pdf__');
    expect(eligibility.menuVisible).toBe(true);

    await extensionWorker.evaluate(async tabId => {
      await handleBlbSelectionContextMenuClick({
        menuItemId:'blb-suite-pdf-selection',
        selectionText:'John 3:16'
      }, {
        id:tabId,
        url:'file:///C:/Bible/notes.pdf',
        title:'notes.pdf'
      });
    }, sourceTabId);

    // The shared BLB destination manager intentionally reuses an existing
    // John 3:16 tab when one is already open. Verify the destination is active,
    // rather than requiring every successful handoff to create a new tab.
    await expect.poll(() => extensionWorker.evaluate(async () => {
      const tabs=await chrome.tabs.query({});
      return tabs.some(tab => tab.active &&
        String(tab.url || tab.pendingUrl || '').includes('/kjv/jhn/3/16/'));
    }), {timeout:15000}).toBe(true);
  } finally {
    await extensionWorker.evaluate(async ({settings,before}) => {
      const tabs=await chrome.tabs.query({});
      const created=tabs.filter(tab => !before.includes(tab.id) &&
        String(tab.url || '').includes('blueletterbible.org'));
      await Promise.all(created.map(tab => chrome.tabs.remove(tab.id).catch(() => {})));
      await chrome.storage.local.set(settings);
    }, {
      settings:previous,
      before:beforeTabs
    });
  }
});
