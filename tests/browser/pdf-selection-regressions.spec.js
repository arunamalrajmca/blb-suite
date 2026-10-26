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
