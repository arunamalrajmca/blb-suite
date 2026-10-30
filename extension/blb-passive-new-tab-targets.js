// Owns passive target="_blank" hints for dynamic/native BLB verse links.
(function (global) {
  function initialize({ BLB_HOSTNAME, isSuiteEnabledNow, suiteSettingsReadyPromise }) {
    if (!location.hostname.endsWith(BLB_HOSTNAME)) return;

    const managedLinks = new WeakSet();
    let settingsReady = false;

    const applyPassiveNewTabTargets = (root=document) => {
      const apply = link => {
        if (!link || !link.href) return;
        const isKjvVerse = /\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href);
        if (isSuiteEnabledNow() && isKjvVerse) {
          link.target = "_blank";
          managedLinks.add(link);
        } else if (!isSuiteEnabledNow() && managedLinks.has(link)) {
          // Remove only the hint this feature added; preserve site-authored targets.
          if (link.getAttribute("target") === "_blank") link.removeAttribute("target");
          managedLinks.delete(link);
        }
      };
      if (root.matches?.("a[href]")) apply(root);
      root.querySelectorAll?.("a[href]").forEach(apply);
    };

    const schedulePassiveNewTabTargets = (() => {
      let scheduled = false;
      const pending = [];
      return (root=null) => {
        if (root) pending.push(root);
        if (!settingsReady || scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          if (!pending.length) {
            applyPassiveNewTabTargets();
            return;
          }
          const roots = pending.splice(0, pending.length);
          const seen = new Set();
          for (const item of roots) {
            if (!item || seen.has(item) || !item.isConnected) continue;
            seen.add(item);
            applyPassiveNewTabTargets(item);
          }
        });
      };
    })();

    const passiveNewTabObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) schedulePassiveNewTabTargets(node);
        }
      }
    });
    passiveNewTabObserver.observe(document.documentElement, { childList:true, subtree:true });

    // Do not inspect or modify links until the authoritative master setting has
    // been loaded. Then process the current page once using the settled state.
    Promise.resolve(suiteSettingsReadyPromise)
      .catch(() => {})
      .then(() => {
        settingsReady = true;
        schedulePassiveNewTabTargets();
      });

    return Object.freeze({
      refresh() {
        if (settingsReady) schedulePassiveNewTabTargets();
      }
    });
  }

  global.BLBPassiveNewTabTargetsModule = Object.freeze({ initialize });
})(globalThis);
