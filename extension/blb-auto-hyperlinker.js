// BLB text-to-HTML formatting for copy-as-link behavior.
// This module is DOM-independent; content.js owns event lifecycle and policy.
globalThis.BLBAutoHyperlinkModule = Object.freeze({
  format(rawText, blbHomeUrl) {
    function format(rawText, blbHomeUrl) {
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
  }
});
