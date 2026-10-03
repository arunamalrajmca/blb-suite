// Blue Letter Bible Suite — offscreen clipboard writer
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'blbSuiteOffscreenClipboard') return;

  (async () => {
    try {
      const plain = String(message.plain || '');
      const html = String(message.html || '');
      if (!plain && !html) {
        sendResponse({ok:false, reason:'empty'});
        return;
      }

      const item = new ClipboardItem({
        'text/plain': new Blob([plain], {type:'text/plain'}),
        'text/html': new Blob([html], {type:'text/html'})
      });
      console.log('[BLB Suite] Offscreen clipboard write starting', {
        plainLength: plain.length,
        htmlLength: html.length,
        types: Object.keys(item)
      });

      await navigator.clipboard.write([item]);
      console.log('[BLB Suite] Offscreen clipboard write succeeded');
      sendResponse({ok:true});
    } catch (error) {
      console.error('[BLB Suite] Offscreen clipboard write failed', error);
      sendResponse({
        ok:false,
        reason:String(error?.message || error || 'clipboard-write-failed')
      });
    }
  })();

  return true;
});
