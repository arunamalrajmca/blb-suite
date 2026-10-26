/*
 * Webster's 1828 dictionary collection feature.
 * Shared content-script helpers are injected explicitly by content.js.
 */
globalThis.BLBWebsterCollectorModule = Object.freeze({
  initialize({ normalizeSelectionText, parseRef, blbUrl, isSuiteEnabled, isModifiedLinkActivation, makeBlbMultiVerseButtonDraggable }) {
    // ---------- Webster's 1828 ----------
    if (location.hostname==="webstersdictionary1828.com") {
      async function captureWebsterWord() {
        try {
          if (!(await isSuiteEnabled())) return;
          const active = await chrome.runtime.sendMessage({type:'blbSuiteStudyCaptureActive'});
          if (!active?.active) return;
          const parts = location.pathname.split('/').filter(Boolean);
          if (parts.length !== 2 || parts[0].toLowerCase() !== 'dictionary') return;
          const word = normalizeSelectionText(decodeURIComponent(parts[1]).replace(/[-_]+/g,' '));
          if (!word || /^(search|index|browse|title-page)$/i.test(word)) return;
          await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudySearchTerm', term:word});
        } catch (_) {}
      }
      captureWebsterWord();
    
      function collectWebsterBibleRefs() {
        const refs=[];
        const seen=new Set();
        document.querySelectorAll("a.bible").forEach(a=>{
          const ref=parseRef(normalizeSelectionText(a.innerText||a.textContent||""));
          if (!ref) return;
          const target=blbUrl(ref.book,ref.chapter,ref.from,ref.to);
          if (!target || seen.has(target)) return;
          seen.add(target);
          refs.push({book:ref.book,chapter:ref.chapter,from:ref.from,to:ref.to,text:normalizeSelectionText(a.innerText||a.textContent||""),url:target});
        });
        return refs;
      }
    
      function showWebsterStatus(message, isError=false) {
        let box=document.getElementById("blb-suite-webster-status");
        if (!box) {
          box=document.createElement("div");
          box.id="blb-suite-webster-status";
          box.style.cssText="position:fixed;right:18px;bottom:72px;z-index:2147483647;background:#fff;border:1px solid #bbb;border-radius:6px;padding:9px 12px;font:13px Arial,sans-serif;color:#222;box-shadow:0 2px 10px rgba(0,0,0,.18);";
          document.body.appendChild(box);
        }
        box.textContent=message;
        box.style.color=isError ? "#b00020" : "#222";
        clearTimeout(box._timer);
        box._timer=setTimeout(()=>box.remove(),3500);
      }
    
      function openAllWebsterRefs() {
        const refs=collectWebsterBibleRefs();
        if (!refs.length) {
          showWebsterStatus("No Bible references found on this page.", true);
          return;
        }
        if (refs.length === 1) {
          // A single Webster reference is opened directly by the background tab manager.
          // Do not display a client-side failure toast here: the tab operation can succeed
          // even when the one-shot response channel closes before the content script
          // receives its acknowledgement.
          chrome.runtime.sendMessage({
            type:'blbSuiteOpenBackgroundUrl',
            url:refs[0].url,
            activeIfNew:true,
            activateExisting:true
          }).catch(()=>{});
          return;
        }
        chrome.runtime.sendMessage({type:'blbSuiteOpenWebsterMultiVerse', refs}).then(response=>{
          if (!response?.ok) {
            showWebsterStatus("Unable to open BLB MultiVerse.", true);
            return;
          }
          showWebsterStatus(`Opening ${refs.length} Bible references in BLB MultiVerse…`);
        }).catch(()=>showWebsterStatus("Unable to open BLB MultiVerse.", true));
      }
    
      async function addWebsterMultiVerseButton() {
        if (!(await isSuiteEnabled())) return;
        if (!document.body || document.getElementById("blb-suite-webster-multiverse")) return;
        const mount=document.body || document.documentElement;
        if (!mount) return;
        const button=document.createElement("button");
        button.id="blb-suite-webster-multiverse";
        button.type="button";
        button.textContent="Open Bible References in BLB";
        button.title="Collect all Bible-reference links on this Webster's 1828 page and open them together in BLB MultiVerse.";
        button.style.cssText="position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#292a2d;color:#f1f3f4;border:1px solid #505257;border-radius:7px;padding:10px 13px;font:600 13px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .12s ease,box-shadow .12s ease,background .12s ease;"; button.addEventListener("mouseenter",()=>{button.style.background="#303136";button.style.transform="translateY(-1px)";button.style.boxShadow="0 4px 12px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.1)";}); button.addEventListener("mouseleave",()=>{button.style.background="#292a2d";button.style.transform="translateY(0)";button.style.boxShadow="0 2px 8px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08)";}); button.addEventListener("mousedown",()=>{button.style.transform="translateY(1px)";button.style.boxShadow="0 1px 3px rgba(0,0,0,.38),inset 0 1px 2px rgba(0,0,0,.22)";}); button.addEventListener("mouseup",()=>{button.style.transform="translateY(-1px)";button.style.boxShadow="0 4px 12px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.1)";});
        button.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();openAllWebsterRefs();});
        mount.appendChild(button);
        makeBlbMultiVerseButtonDraggable(button);
      }
    
      // Global external redirects default OFF. Keep this handler fail-closed when storage is empty or unavailable.
      let websterRedirectEnabled = false;
      chrome.storage.local.get({redirectEnabled:false}).then(data=>{
        websterRedirectEnabled = data.redirectEnabled !== false;
      }).catch(()=>{});
    
      document.addEventListener("click",e=>{
        if (!suiteEnabled || !websterRedirectEnabled || isModifiedLinkActivation(e)) return;
        const a=e.target.closest?.("a.bible");
        if (!a) return;
        const ref=parseRef(normalizeSelectionText(a.innerText||a.textContent||""));
        if (!ref) return;
        const target=blbUrl(ref.book,ref.chapter,ref.from,ref.to);
        if (!target) return;
        e.preventDefault(); e.stopImmediatePropagation();
        chrome.runtime.sendMessage({
          type:'blbSuiteOpenBackgroundUrl',
          url:target,
          activeIfNew:true,
          activateExisting:true
        }).catch(()=>{});
      },true);
    
      // Webster pages can restore/rebuild their body during a normal refresh.
      // Retry after DOM readiness so the button is present without requiring a
      // hard refresh. The duplicate guard inside addWebsterMultiVerseButton()
      // keeps these retries harmless.
      const ensureWebsterButton=()=>{
        if (!suiteEnabled) return;
        addWebsterMultiVerseButton().catch(()=>{});
      };
      globalThis.BLBWebsterCollector = Object.freeze({ ensureButton: ensureWebsterButton });
      if (document.readyState==="loading") {
        document.addEventListener("DOMContentLoaded",ensureWebsterButton,{once:true});
      } else {
        ensureWebsterButton();
      }
      setTimeout(ensureWebsterButton,250);
      setTimeout(ensureWebsterButton,1000);
      setTimeout(ensureWebsterButton,2000);
      let websterButtonCheckScheduled=false;
      const scheduleWebsterButtonCheck=()=>{
        if (websterButtonCheckScheduled) return;
        websterButtonCheckScheduled=true;
        requestAnimationFrame(()=>{
          websterButtonCheckScheduled=false;
          if (!document.getElementById("blb-suite-webster-multiverse")) ensureWebsterButton();
        });
      };
      // Only watch direct document-element changes so we can recover if the page
      // replaces its <body>. Watching the entire Webster DOM is unnecessary and
      // would wake the extension for unrelated page mutations.
      const websterBodyObserver=new MutationObserver(scheduleWebsterButtonCheck);
      const startWebsterObserver=()=>{
        if (document.documentElement) websterBodyObserver.observe(document.documentElement,{childList:true});
      };
      if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",startWebsterObserver,{once:true});
      else startWebsterObserver();
    }
    
    
  }
});
