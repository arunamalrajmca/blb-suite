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

      // PDF-originated batches use a dedicated queue. The standard MultiVerse
      // queue keeps its existing 1500 ms spacing; PDF batches use 750 ms.
      const slot = await chrome.runtime.sendMessage({
        type:'blbSuiteAcquireMultiVersePostSlot',
        pdfFastSubmit:isPdfFastSubmit
      }).catch(error => ({ok:false, error:String(error)}));
      if (!slot?.ok) {
        showFailure('Unable to queue this Multi-Verse request. Please retry this tab.');
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
