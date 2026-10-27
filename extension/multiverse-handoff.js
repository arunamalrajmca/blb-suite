// Hides Suite-generated MultiVerse pages until the requested results are visible.
(function (global) {
  function initialize({ BLBShared, isSuiteEnabled, resolveBibleBook }) {
    // ---------- BLB MultiVerse hand-off ----------
    // Suite-generated MultiVerse tabs must never expose BLB's bootstrap/default
    // result set. Keep the document hidden until the requested reference set is
    // actually visible after Retrieve has completed.
    if (location.hostname===BLBShared.hostnames.blbWww &&
        /(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)/i.test(location.pathname) &&
        /[?&]blbSuiteMultiVerse=1(?:&|$)/i.test(location.search)) {
      let multiverseHandoffHidden=false;
      let multiverseRevealTimer=0;
    
      const revealPendingMultiVerseView=()=>{
        if (!multiverseHandoffHidden) return;
        multiverseHandoffHidden=false;
        try {
          document.documentElement.style.visibility='';
          delete document.documentElement.dataset.blbSuiteMultiVersePending;
        } catch (_) {}
        if (multiverseRevealTimer) {
          clearTimeout(multiverseRevealTimer);
          multiverseRevealTimer=0;
        }
      };
    
      const hidePendingMultiVerseView=()=>{
        if (multiverseHandoffHidden) return;
        try {
          document.documentElement.dataset.blbSuiteMultiVersePending='1';
          document.documentElement.style.visibility='hidden';
          multiverseHandoffHidden=true;
          multiverseRevealTimer=window.setTimeout(revealPendingMultiVerseView,10000);
        } catch (_) {}
      };
    
      const hasExpectedMultiVerseResults=(refs)=>{
        try {
          const expected=refs.map(ref=>{
            const book=resolveBibleBook(ref.book);
            if (!book) return null;
            return {urlKey:String(book.urlKey||'').toLowerCase(),chapter:Number(ref.chapter),from:ref.from==null?null:Number(ref.from)};
          }).filter(Boolean);
          if (expected.length!==refs.length) return false;
    
          const links=Array.from(document.querySelectorAll('a[href*="/kjv/"]'));
          if (!links.length) return false;
          return expected.every(want=>links.some(link=>{
            try {
              const path=new URL(link.href,location.href).pathname;
              const m=path.match(/^\/kjv\/([^/]+)\/(\d+)\/(\d+)(?:-\d+)?\/?$/i);
              if (!m) return false;
              if (m[1].toLowerCase()!==want.urlKey || Number(m[2])!==want.chapter) return false;
              return want.from==null || Number(m[3])===want.from;
            } catch (_) { return false; }
          }));
        } catch (_) {
          return false;
        }
      };
    
      async function waitForExpectedMultiVerseResults(refs){
        const started=Date.now();
        while (Date.now()-started<10000) {
          if (hasExpectedMultiVerseResults(refs)) return true;
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        return false;
      }
    
      async function processPendingMultiVerseRefs() {
        if (!(await isSuiteEnabled())) {
          revealPendingMultiVerseView();
          return false;
        }
        hidePendingMultiVerseView();
        const response=await chrome.runtime.sendMessage({type:'blbSuiteGetPendingMultiVerseRefs'});
        const refs=response?.refs;
        if (!Array.isArray(refs) || refs.length<1) {
          revealPendingMultiVerseView();
          return false;
        }
    
        const values=refs.map(r=>`${r.book} ${r.chapter}:${r.from}${r.to && r.to!==r.from ? "-"+r.to : ""}`);
        const combined=values.join("; ");
    
        const started=Date.now();
        let heading=null, advancedHeading=null, verseControls=[], retrieve=null;
        while (Date.now()-started<4000) {
          heading=Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,td,th,label"))
            .find(el=>/^\s*multiverse retrieval\s*$/i.test((el.innerText||el.textContent||"").trim()));
          if (heading) {
            advancedHeading=Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,td,th,label"))
              .find(el=>/^\s*advanced multiverse search options\s*$/i.test((el.innerText||el.textContent||"").trim()));
            const allControls=Array.from(document.querySelectorAll("input[type=text], textarea, input:not([type])"));
            const beforeAdvanced=el=>!advancedHeading || !!(advancedHeading.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_PRECEDING);
            const afterHeading=el=>!!(heading.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING);
            verseControls=allControls.filter(el=>afterHeading(el)&&beforeAdvanced(el)).slice(0,10);
            retrieve=Array.from(document.querySelectorAll("button,input[type=submit],input[type=button],a"))
              .find(x=>/^\s*retrieve\s*$/i.test((x.innerText||x.value||"").trim()) &&
                (!advancedHeading || !!(advancedHeading.compareDocumentPosition(x)&Node.DOCUMENT_POSITION_PRECEDING)));
            if (verseControls.length&&retrieve) break;
          }
          await new Promise(resolve=>setTimeout(resolve,50));
        }
    
        if (!verseControls.length||!retrieve) {
          revealPendingMultiVerseView();
          return false;
        }
    
        const setNativeValue=(el,value)=>{
          const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
          const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;
          if (setter) setter.call(el,value); else el.value=value;
          for (const type of ["input","change","keyup","blur"]) el.dispatchEvent(new Event(type,{bubbles:true}));
        };
    
        verseControls.forEach(c=>setNativeValue(c,""));
        const primary=verseControls[0];
        if (!combined||!primary) {
          revealPendingMultiVerseView();
          return false;
        }
        setNativeValue(primary,combined);
        primary.setAttribute("value",combined);
    
        const valueStarted=Date.now();
        let actual="";
        while (Date.now()-valueStarted<1000) {
          actual=String(primary.value||primary.getAttribute("value")||"").trim();
          if (actual===combined) break;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        if (actual!==combined) {
          revealPendingMultiVerseView();
          return false;
        }
    
        await chrome.runtime.sendMessage({type:'blbSuiteConsumePendingMultiVerseRefs'}).catch(()=>{});
        retrieve.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,view:window}));
        retrieve.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,cancelable:true,view:window}));
        retrieve.click();
    
        // Do not reveal merely because Retrieve was clicked. BLB updates the result
        // area asynchronously; reveal only after the requested references are
        // actually present, so the normal bootstrap/default verses cannot flash.
        await waitForExpectedMultiVerseResults(refs);
        revealPendingMultiVerseView();
        return true;
      }
    
      const tryProcess=()=>processPendingMultiVerseRefs().catch(()=>revealPendingMultiVerseView());
      if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",tryProcess,{once:true});
      else void tryProcess();
    }
    
    
    
  }
  global.BLBMultiVerseHandoffModule = { initialize };
})(globalThis);
