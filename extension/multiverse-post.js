(() => {
  'use strict';

  const status = document.getElementById('status');
  const handoffParams = new URLSearchParams(location.search);
  const mvTextFromUrl = handoffParams.get('mvText') || '';
  const isPdfFastSubmit = handoffParams.get('mvPdfFast') === '1';
  const pdfTraceId = handoffParams.get('mvPdfTrace') || 'untracked';
  const pdfBatchIndex = Number(handoffParams.get('mvPdfBatchIndex') || 0);
  const pdfBatchCount = Number(handoffParams.get('mvPdfBatchCount') || 1);
  const pdfTraceStart = Date.now();
  const trace = (stage, details = {}) => {
    if (isPdfFastSubmit) console.info('[BLB PDF MultiVerse timing]', JSON.stringify({id:pdfTraceId, stage, elapsedMs:Date.now()-pdfTraceStart, at:Date.now(), ...details}));
  };
  trace('handoff-page-start', {readyState:document.readyState, textChars:mvTextFromUrl.length});

  const showFailure = message => {
    status.textContent = message;
  };

  async function submitDirectPost() {
    try {
      const mvText = mvTextFromUrl.trim();
      trace('submit-handler-start', {textChars:mvText.length});
      if (!mvText) {
        showFailure('No references were supplied for this tab. Please retry the selection.');
        return;
      }

      // Keep all submissions in the background's shared FIFO queue. The
      // queue response includes diagnostic detail if admission fails.
      let slot;
      let queueError = null;
      // Extension service workers can occasionally drop a long-lived message
      // response while a queued timer is pending. Retry once on a fresh message
      // channel; do not bypass the shared queue or submit twice after a success.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          trace('queue-request-start', {attempt});
          slot = await chrome.runtime.sendMessage({
            type:'blbSuiteAcquireMultiVersePostSlot',
            pdfFastSubmit:isPdfFastSubmit,
            pdfTraceId,
            pdfBatchIndex,
            pdfBatchCount
          });
          queueError = null;
          break;
        } catch (error) {
          queueError = error;
          trace('queue-request-error', {attempt, error:String(error)});
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      if (queueError) {
        showFailure('Multi-Verse queue connection failed after retry: ' + String(queueError));
        return;
      }
      trace('queue-response', {ok:!!slot?.ok});
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
      trace('form-submit', {action:form.action, fields:Object.keys(fields).length});
      form.submit();
    } catch (error) {
      showFailure('Unable to submit the requested references: ' + String(error));
    }
  }

  void submitDirectPost();
})();
