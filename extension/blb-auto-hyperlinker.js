// BLB text-to-HTML formatting for copy-as-link behavior.
// This module is DOM-independent; content.js owns event lifecycle and policy.
globalThis.BLBAutoHyperlinkModule = Object.freeze({
  initialize({ isSuiteEnabled, getCachedEnabled, blbHostname, blbHomeUrl }) {
    if (!location.hostname.endsWith(blbHostname)
        || /(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)) return;
      // The copy event must be handled synchronously. Awaiting storage state inside
      // the event handler lets the browser finish its normal copy operation before
      // preventDefault() runs, which loses the HTML clipboard payload used by
      // Word/Google Docs "Paste as link" behavior. The content script already
      // maintains getCachedEnabled() through storage.onChanged, so use that cached value.
      document.addEventListener("copy",e=>{
        if (!getCachedEnabled()) return;
        const text=window.getSelection()?.toString()||"";
        const html=format(text);
        if (!html || !e.clipboardData) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.clipboardData.setData("text/html",html);
        e.clipboardData.setData("text/plain",text);
      },true);
    
      if (navigator.clipboard?.writeText) {
        const original=navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText=async text=>{
          if (!(await isSuiteEnabled())) return original(text);
          const html=format(text);
          if (!html) return original(text);
          const handler=e=>{
            e.clipboardData.setData("text/html",html);
            e.clipboardData.setData("text/plain",text);
            e.preventDefault();
          };
          document.addEventListener("copy",handler,true);
          document.execCommand("copy");
          document.removeEventListener("copy",handler,true);
        };
      }
  },
  format(rawText, blbHomeUrl) {
  const refs=rawText.match(/\b(?:[1-3]\s*|i{1,3}\s*)?[A-Za-z0-9.]+\s+\d+:\d+(?:-\d+)?\b/gi);
  if (!refs) return null;
  let html=rawText;
  refs.forEach(ref=>{
    const x=ref.trim(), i=x.lastIndexOf(" ");
    if (i<0) return;
    const book=x.slice(0,i).replace(/\./g,"").replace(/\s+/g,"");
    const cv=x.slice(i+1).replace(":","/");
    html=html.replace(ref,`<a href="${blbHomeUrl}kjv/${book}/${cv}/" style="color:#1155cc;text-decoration:underline;">${ref}</a>`);
  });
  html=html.replace(/\n/g,"<br>");
  return `<!DOCTYPE html><html><body><!--StartFragment--><span style="font-family:Arial,sans-serif;">${html}</span><!--EndFragment--></body></html>`;
  }
});
