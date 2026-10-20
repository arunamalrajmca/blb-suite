(() => {
  'use strict';

  const status = document.getElementById('status');
  const handoffParams = new URLSearchParams(location.search);
  const mvTextFromUrl = handoffParams.get('mvText') || '';
  const isPdfFastSubmit = handoffParams.get('mvPdfFast') === '1';

  const showFailure = message => {
    status.textContent = message;
  };

  async function submitDirectPost() {
    try {
      const mvText = mvTextFromUrl.trim();
      if (!mvText) {
        showFailure('No references were supplied for this tab. Please retry the selection.');
        return;
      }

      // Keep all submissions in the background's shared FIFO queue. The
      // queue response includes diagnostic detail if admission fails.
      let slot;
      try {
        slot = await chrome.runtime.sendMessage({
          type:'blbSuiteAcquireMultiVersePostSlot',
          pdfFastSubmit:isPdfFastSubmit
        });
      } catch (error) {
        showFailure('Multi-Verse queue connection failed: ' + String(error));
        return;
      }
      if (!slot?.ok) {
        const detail = slot?.error ? ' Details: ' + String(slot.error) : ' The background queue did not return a successful response.';
        showFailure('Unable to queue this Multi-Verse request.' + detail + ' Please retry this tab.');
        return;
      }

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
      form.submit();
    } catch (error) {
      showFailure('Unable to submit the requested references: ' + String(error));
    }
  }

  void submitDirectPost();
})();
