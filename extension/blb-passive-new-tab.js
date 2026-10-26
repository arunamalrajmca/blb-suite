// Passive new-tab targets for dynamically inserted BLB verse links.
globalThis.BLBPassiveNewTabModule = Object.freeze({
  initialize({ getCachedEnabled, blbHostname }) {
    // Keep this separate from the existing copy/hyperlink handler.  Do not cancel
    // native BLB clicks; only supply target="_blank" to verse links that BLB adds
    // dynamically or places outside the older bVerse_ containers.
    if (location.hostname.endsWith(blbHostname)) {
      const applyPassiveNewTabTargets = (root=document) => {
        if (!getCachedEnabled()) return;
        const apply = link => {
          if (!link || !link.href) return;
          if (/\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href)) {
            link.target="_blank";
          }
        };
        if (root.matches?.("a[href]")) apply(root);
        root.querySelectorAll?.("a[href]").forEach(apply);
      };
    
      const schedulePassiveNewTabTargets = (() => {
        let scheduled=false;
        const pending=[];
        return (root=null) => {
          if (root) pending.push(root);
          if (scheduled) return;
          scheduled=true;
          requestAnimationFrame(() => {
            scheduled=false;
            if (!getCachedEnabled()) { pending.length=0; return; }
            if (!pending.length) {
              applyPassiveNewTabTargets();
              return;
            }
            const roots=pending.splice(0,pending.length);
            const seen=new Set();
            for (const root of roots) {
              if (!root || seen.has(root) || !root.isConnected) continue;
              seen.add(root);
              applyPassiveNewTabTargets(root);
            }
          });
        };
      })();
    
      const passiveNewTabObserver=new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType===1) schedulePassiveNewTabTargets(node);
          }
        }
      });
      passiveNewTabObserver.observe(document.documentElement,{childList:true,subtree:true});
    
      if (document.readyState==="loading") {
        document.addEventListener("DOMContentLoaded",() => schedulePassiveNewTabTargets());
      } else {
        schedulePassiveNewTabTargets();
      }
    }
  }
});
