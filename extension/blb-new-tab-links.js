// Normal BLB verse-page link targeting and native-link handoff.
globalThis.BLBNewTabLinksModule = Object.freeze({
  initialize({ getCachedEnabled, isModifiedLinkActivation, openBlbDestinationFromContent, blbHostname }) {
    if (!location.hostname.endsWith(blbHostname)
        || /(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)) return;
      function modifyLinks(container) {
        container.querySelectorAll("a").forEach(link=>{
          if (!link.href) return;
          if (link.closest(".parse-popup")) {
            // Parsing-popup links are handled by the shared BLB parse-popup handler
            // below so Criteria Search pages and normal verse pages use the same
            // single-tab/reuse behavior.
          } else if (link.closest('div[id^="bVerse_"]')) {
            link.target="_blank";
          }
        });
      }
    
      function modifyMultiVerseLinks() {
        if (!location.href.includes("MultiVerse.cfm")) return;
        document.querySelectorAll('a[href*="/kjv/"]').forEach(a=>a.target="_blank");
      }
    
      const process=(root=document)=>{
        if (!getCachedEnabled()) return;
        if (root.matches?.('div[id^="bVerse_"], .parse-popup')) modifyLinks(root);
        root.querySelectorAll?.('div[id^="bVerse_"], .parse-popup').forEach(modifyLinks);
        if (location.href.includes("MultiVerse.cfm")) {
          if (root.matches?.('a[href*="/kjv/"]')) root.target="_blank";
          root.querySelectorAll?.('a[href*="/kjv/"]').forEach(a=>a.target="_blank");
        }
      };
      let processScheduled=false;
      const pendingRoots=[];
      const scheduleProcess=(root=null)=>{
        if (root) pendingRoots.push(root);
        if (processScheduled) return;
        processScheduled=true;
        requestAnimationFrame(()=>{
          processScheduled=false;
          if (!getCachedEnabled()) { pendingRoots.length=0; return; }
          if (!pendingRoots.length) { process(); return; }
          const roots=pendingRoots.splice(0,pendingRoots.length);
          const seen=new Set();
          for (const root of roots) {
            if (!root || seen.has(root) || !root.isConnected) continue;
            seen.add(root);
            process(root);
          }
        });
      };
      const observer=new MutationObserver(mutations=>{
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType===1) scheduleProcess(node);
          }
        }
      });
      observer.observe(document.documentElement,{childList:true,subtree:true});
      document.addEventListener("click",e=>{
        if (!getCachedEnabled() || isModifiedLinkActivation(e)) return;
        const a=e.target.closest?.("a.nowrap");
        if (!a) return;
    
        // Criteria Search owns ordinary KJV verse links below. Let its dedicated
        // handler below be the sole Suite owner for those links.
        if (
          location.pathname.toLowerCase() === "/search/search.cfm" &&
          /\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(a.href)
        ) return;
    
        e.preventDefault(); e.stopImmediatePropagation(); openBlbDestinationFromContent(a.href);
      },true);
      if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",process);
      else process();
  }
});
