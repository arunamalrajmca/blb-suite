(() => {
  'use strict';

  const status = document.getElementById('status');
  const handoffParams = new URLSearchParams(location.search);
  const mvTextFromUrl = handoffParams.get('mvText') || '';
  const handoffStartedAt = Date.now();
  console.info('[BLB MV timing]', {stage:'handoff-script-start', at:handoffStartedAt, refChars:mvTextFromUrl.length});

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
      const queueRequestedAt = Date.now();
      console.info('[BLB MV timing]', {stage:'queue-request-sent', at:queueRequestedAt, sinceHandoffStartMs:queueRequestedAt-handoffStartedAt, refChars:mvText.length});
      let slot;
      let queueError = null;
      // Extension service workers can occasionally drop a long-lived message
      // response while a queued timer is pending. Retry once on a fresh message
      // channel; do not bypass the shared queue or submit twice after a success.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          slot = await chrome.runtime.sendMessage({
            type:'blbSuiteAcquireMultiVersePostSlot',
          });
          queueError = null;
          break;
        } catch (error) {
          queueError = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      if (queueError) {
        showFailure('Multi-Verse queue connection failed after retry: ' + String(queueError));
        return;
      }
      console.info('[BLB MV timing]', {stage:'queue-response-received', at:Date.now(), sinceQueueRequestMs:Date.now()-queueRequestedAt, sinceHandoffStartMs:Date.now()-handoffStartedAt, ok:!!slot?.ok});
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
      console.info('[BLB MV timing]', {stage:'form-submit', at:Date.now(), sinceHandoffStartMs:Date.now()-handoffStartedAt, sinceQueueRequestMs:Date.now()-queueRequestedAt});
      form.submit();
    } catch (error) {
      showFailure('Unable to submit the requested references: ' + String(error));
    }
  }

  void submitDirectPost();
})();
