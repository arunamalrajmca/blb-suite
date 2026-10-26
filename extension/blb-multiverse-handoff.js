// MultiVerse destination hand-off, result verification, and Study capture.
globalThis.BLBMultiVerseHandoffModule = Object.freeze({
  initialize({ isSuiteEnabled, resolveBibleBook, normalizeSelectionText, blbHostname, blbWwwHostname }) {
    // Suite-generated MultiVerse tabs must never expose BLB's bootstrap/default
    // result set. Keep the document hidden until the requested reference set is
    // actually visible after Retrieve has completed.
    if (location.hostname===blbWwwHostname &&
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
    
    
    // // ---------- Study reference capture ----------
    // Capture only useful BLB Bible/Strong's destinations while a named Study Topic
    // is active. This is deliberately navigation/result based: no click logging,
    // polling, or page-wide MutationObserver is used for the audit.
    if (location.hostname.toLowerCase().replace(/^www\./,'') === blbHostname) {
      const captureStudyRefs = async () => {
        try {
          if (!(await isSuiteEnabled())) return;
          const active = await chrome.runtime.sendMessage({type:'blbSuiteStudyCaptureActive'});
          if (!active?.active) return;
    
          const refs = new Map();
          const addUrl = href => {
            try {
              const u = new URL(String(href || ''), location.href);
              const host = u.hostname.toLowerCase().replace(/^www\./,'');
              if (host !== blbHostname) return;
              const parts = u.pathname.split('/').filter(Boolean);
              if (parts.length < 3 || parts[0].toLowerCase() !== 'kjv' || !/^\d+$/.test(parts[2])) return;
              // Verse/result links have a verse component. Chapter links are handled
              // from the current page URL only, so navigation menus do not pollute
              // search-result capture.
              if (parts.length < 4) return;
              const vm = String(parts[3]).match(/^(\d+)(?:-(\d+))?$/);
              if (!vm) return;
              const key = `${parts[1].toLowerCase()}|${parts[2]}|${vm[1]}|${vm[2] || vm[1]}`;
              refs.set(key,{urlKey:parts[1].toLowerCase(),chapter:Number(parts[2]),from:Number(vm[1]),to:Number(vm[2] || vm[1]),version:'kjv'});
            } catch (_) {}
          };
    
          // Native BLB Search: record only the search term, never the potentially
          // enormous set of verses returned by the search.
          if (/\/search\/(?:search|preSearch)\.cfm/i.test(location.pathname)) {
            const currentUrl = new URL(location.href);
            // MultiVerse intentionally opens BLB's search page with a temporary
            // default Criteria=Jesus before populating the real MultiVerse inputs.
            // That bootstrap term is not a user search and must never enter Study
            // History.
            if (currentUrl.searchParams.get('blbSuiteMultiVerse') === '1') return;
            const criteria = normalizeSelectionText(String(currentUrl.searchParams.get('Criteria') || '').replace(/\+/g, ' '));
            if (criteria) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudySearchTerm', term:criteria});
            return;
          }
    
          // Current Bible page / redirected Bible page only. Search and MultiVerse
          // result lists are deliberately not bulk-captured.
          addUrl(location.href);
          if (refs.size) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudyRefs', refs:[...refs.values()]});
        } catch (_) {}
      };
    
      const captureStrong = async () => {
        try {
          if (!(await isSuiteEnabled())) return;
          const active = await chrome.runtime.sendMessage({type:'blbSuiteStudyCaptureActive'});
          if (!active?.active) return;
          const m = location.pathname.match(/\/lexicon\/(g|h)(\d+)\//i);
          if (m) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudyStrong', value:`${m[1]}${m[2]}`});
        } catch (_) {}
      };
    
      const runStudyCapture = () => { captureStudyRefs(); captureStrong(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',runStudyCapture,{once:true});
      else runStudyCapture();
    }
  }
});
