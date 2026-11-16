// Owns passive target="_blank" hints for dynamic/native BLB verse links.
(function (global) {
  function initialize({ BLB_HOSTNAME, isSuiteEnabledNow, suiteSettingsReadyPromise }) {
    global.__blbPassiveNewTabTargetsCleanup?.();
    if (!location.hostname.endsWith(BLB_HOSTNAME)) return;
    // Keep original target values so cleanup/reinjection can undo only the
    // target changes this instance still owns.
    const managedLinks = new Map();
    let settingsReady = false, active = true, scheduledFrame = 0;
    const applyPassiveNewTabTargets = (root=document) => {
      const apply = link => {
        if (!link || !link.href) return;
        const isKjvVerse = /\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href);
        if (isSuiteEnabledNow() && isKjvVerse) {
          if (!managedLinks.has(link)) managedLinks.set(link, link.getAttribute("target"));
          link.target = "_blank";
        } else if (managedLinks.has(link)) {
          const originalTarget = managedLinks.get(link);
          if (link.getAttribute("target") === "_blank") {
            if (originalTarget === null) link.removeAttribute("target");
            else link.setAttribute("target", originalTarget);
          }
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
        if (!active) return;
        if (root) pending.push(root);
        if (!settingsReady || scheduled) return;
        scheduled = true;
        scheduledFrame = requestAnimationFrame(() => {
          scheduledFrame = 0; scheduled = false;
          if (!active) return;
          if (!pending.length) { applyPassiveNewTabTargets(); return; }
          const roots = pending.splice(0, pending.length), seen = new Set();
          for (const item of roots) {
            if (!item || seen.has(item) || !item.isConnected) continue;
            seen.add(item); applyPassiveNewTabTargets(item);
          }
        });
      };
    })();
    const passiveNewTabObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) for (const node of mutation.addedNodes)
        if (node.nodeType === 1) schedulePassiveNewTabTargets(node);
    });
    passiveNewTabObserver.observe(document.documentElement, { childList:true, subtree:true });
    const cleanup = () => {
      if (!active) return;
      active = false;
      passiveNewTabObserver.disconnect();
      if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
      scheduledFrame = 0;
      for (const [link, originalTarget] of managedLinks) {
        if (link.getAttribute("target") !== "_blank") continue;
        if (originalTarget === null) link.removeAttribute("target");
        else link.setAttribute("target", originalTarget);
      }
      managedLinks.clear();
      if (global.__blbPassiveNewTabTargetsCleanup === cleanup) {
        delete global.__blbPassiveNewTabTargetsCleanup;
      }
    };
    global.__blbPassiveNewTabTargetsCleanup = cleanup;
    Promise.resolve(suiteSettingsReadyPromise).catch(() => {}).then(() => {
      if (!active) return;
      settingsReady = true; schedulePassiveNewTabTargets();
    });
    return Object.freeze({ cleanup, refresh() { if (active && settingsReady) schedulePassiveNewTabTargets(); } });
  }
  global.BLBPassiveNewTabTargetsModule = Object.freeze({ initialize });
})(globalThis);
