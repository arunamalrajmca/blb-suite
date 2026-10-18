(() => {
  'use strict';

  const status = document.getElementById('status');
  const tabId = new URLSearchParams(location.search).get('tabId');

  const showFailure = message => {
    status.textContent = message;
  };

  const buildReferenceText = refs => refs.map(ref => {
    const book = String(ref.book || '').trim();
    const chapter = Number(ref.chapter);
    const from = Number(ref.from);
    const to = ref.to == null ? from : Number(ref.to);
    if (!book || !Number.isInteger(chapter) || chapter < 1 ||
        !Number.isInteger(from) || from < 1 ||
        !Number.isInteger(to) || to < from) {
      throw new Error('Invalid reference data');
    }
    return book + ' ' + chapter + ':' + from + (to !== from ? '-' + to : '');
  }).join('; ');

  async function submitDirectPost() {
    if (!tabId || !/^\d+$/.test(tabId)) {
      showFailure('Could not identify this MultiVerse tab. Please retry the selection.');
      return;
    }

    try {
      const data = await chrome.storage.local.get({
        blbSuitePendingMultiVerseRefsByTab: {}
      });
      const pending = data.blbSuitePendingMultiVerseRefsByTab;
      const refs = pending && Array.isArray(pending[tabId]) ? pending[tabId] : null;
      if (!refs || !refs.length) {
        showFailure('No references were found for this tab. Please retry the selection.');
        return;
      }

      const mvText = buildReferenceText(refs);
      if (!mvText) throw new Error('Empty reference list');

      const form = document.createElement('form');
      form.method = 'post';
      form.acceptCharset = 'UTF-8';
      form.action = 'https://www.blueletterbible.org/tools/MultiVerse.cfm';

      const fields = {
        refFormat: '4',
        refDelim: '3',
        numDelim: '0',
        abbrev: '0',
        quoted: '0',
        sqrbrkt: '0',
        sblabbrev: '0',
        endash: '0',
        sorted: '0',
        t: 'KJV',
        mvText
      };
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);

      // Consume only this tab's pending handoff before leaving the extension
      // page. Keep the separate tab-set identity record for duplicate handling.
      const nextPending = {...pending};
      delete nextPending[tabId];
      await chrome.storage.local.set({
        blbSuitePendingMultiVerseRefsByTab: nextPending
      });

      form.submit();
    } catch (error) {
      showFailure('Unable to submit the requested references: ' + String(error));
    }
  }

  void submitDirectPost();
})();
