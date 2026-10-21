'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'blbSuiteCopyPlainText') return false;
  const text = String(message.text || '');
  if (!text) {
    sendResponse({ok:false, error:'No selected text'});
    return false;
  }

  (async () => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-10000px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      textarea.remove();
    }
    if (!copied) throw new Error('The browser refused to copy the selected text');
    sendResponse({ok:true});
  })().catch(error => sendResponse({ok:false, error:String(error?.message || error)}));

  return true;
});
