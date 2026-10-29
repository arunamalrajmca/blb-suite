// Owns passive target="_blank" hints for dynamic/native BLB verse links.
(function (global) {
  function initialize({ BLB_HOSTNAME, isSuiteEnabledNow }) {
    if (!location.hostname.endsWith(BLB_HOSTNAME)) return;

    const isKjvVerseLink = link =>
      !!link?.href && /\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href);

    // Only remove targets that this module added. This avoids leaving stale
    // passive targets behind when the master switch is OFF, without changing
    // target attributes authored by the BLB page itself.
    const clearPassiveNewTabTargets = (root = document) => {
      const clear = link => {
        if (link?.hasAttribute("data-blb-passive-new-tab-target")) {
          link.removeAttribute("target");
          link.removeAttribute("data-blb-passive-new-tab-target");
        }
      };
      if (root.matches?.("a[href]")) clear(root);
      root.querySelectorAll?.("a[data-blb-passive-new-tab-target]").forEach(clear);
    };

    const applyPassiveNewTabTargets = (root = document) => {
      if (!isSuiteEnabledNow()) {
        clearPassiveNewTabTargets(root);
        return;
      }
      const apply = link => {
        if (!isKjvVerseLink(link)) return;
        if (link.getAttribute("target") !== "_blank") {
          link.setAttribute("target", "_blank");
          link.setAttribute("data-blb-passive-new-tab-target", "");
        }
      };
      if (root.matches?.("a[href]")) apply(root);
      root.querySelectorAll?.("a[href]").forEach(apply);
    };

    const schedulePassiveNewTabTargets = (() => {
      let scheduled = false;
      const pending = [];
      return (root = null) => {
        if (root) pending.push(root);
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          if (!isSuiteEnabledNow()) {
            clearPassiveNewTabTargets();
            pending.length = 0;
            return;
          }
          if (!pending.length) {
            applyPassiveNewTabTargets();
            return;
          }
          const roots = pending.splice(0, pending.length);
          const seen = new Set();
          for (const pendingRoot of roots) {
            if (!pendingRoot || seen.has(pendingRoot) || !pendingRoot.isConnected) continue;
            seen.add(pendingRoot);
            applyPassiveNewTabTargets(pendingRoot);
          }
        });
      };
    })();

    // Reconcile immediately when the master switch changes; the observer only
    // sees DOM mutations and otherwise leaves our previously-added targets in place.
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes.masterEnabled) return;
      if (changes.masterEnabled.newValue === false) {
        clearPassiveNewTabTargets();
      } else {
        schedulePassiveNewTabTargets();
      }
    });

    const passiveNewTabObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) schedulePassiveNewTabTargets(node);
        }
      }
    });
    passiveNewTabObserver.observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => schedulePassiveNewTabTargets());
    } else {
      schedulePassiveNewTabTargets();
    }
  }

  global.BLBPassiveNewTabTargetsModule = Object.freeze({ initialize });
})(globalThis);
