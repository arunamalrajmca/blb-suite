// Owns BLB verse-link target behavior and ordinary nowrap-link navigation.
(function (global) {
  function initialize({
    BLB_HOSTNAME,
    isSuiteEnabledNow,
    isModifiedLinkActivation,
    openBlbDestinationFromContent,
    suiteSettingsReadyPromise
  }) {
    global.__blbVerseLinkNavigationCleanup?.();
    if (
      !location.hostname.endsWith(BLB_HOSTNAME) ||
      /(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)
    ) return;

    const listenerController = new AbortController();
    const managedTargets = new Map();
    let observer = null, processScheduled = false, scheduledFrame = 0, active = true;
    let settingsReady = false;
    const pendingRoots = [];

    // Restore only target values this module changed. Preserve a site's
    // original target and leave later site-owned changes untouched.
    const restoreManagedTargets = () => {
      for (const [link, originalTarget] of managedTargets) {
        if (!link.isConnected) {
          managedTargets.delete(link);
          continue;
        }
        if (link.getAttribute("target") === "_blank") {
          if (originalTarget === null) link.removeAttribute("target");
          else link.setAttribute("target", originalTarget);
        }
        managedTargets.delete(link);
      }
    };

    const cleanup = () => {
      if (!active) return;
      active = false;
      observer?.disconnect();
      listenerController.abort();
      if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
      scheduledFrame = 0;
      processScheduled = false;
      pendingRoots.length = 0;
      restoreManagedTargets();
      if (global.__blbVerseLinkNavigationCleanup === cleanup) {
        delete global.__blbVerseLinkNavigationCleanup;
      }
    };
    global.__blbVerseLinkNavigationCleanup = cleanup;

    function manageVerseLink(link) {
      if (!link?.matches?.("a") || !link.href || link.closest(".parse-popup") ||
          !link.closest('div[id^="bVerse_"]')) return;
      if (!managedTargets.has(link)) {
        managedTargets.set(link, link.getAttribute("target"));
      }
      link.target = "_blank";
    }

    function modifyLinks(container) {
      if (container.matches?.("a")) manageVerseLink(container);
      container.querySelectorAll("a").forEach(manageVerseLink);
    }

    const process = (root = document) => {
      if (!active) return;
      if (!isSuiteEnabledNow()) {
        restoreManagedTargets();
        return;
      }
      if (root.matches?.('div[id^="bVerse_"], .parse-popup')) modifyLinks(root);
      // A mutation may add an anchor (or a subtree) inside an existing verse
      // container. Process that owning container too; searching only below the
      // added node misses its bVerse ancestor.
      const owningContainer = root.closest?.('div[id^="bVerse_"], .parse-popup');
      if (owningContainer && owningContainer !== root) modifyLinks(owningContainer);
      root.querySelectorAll?.('div[id^="bVerse_"], .parse-popup').forEach(modifyLinks);
    };

    const scheduleProcess = (root = null) => {
      if (!active) return;
      if (!isSuiteEnabledNow()) {
        restoreManagedTargets();
        pendingRoots.length = 0;
        if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
        scheduledFrame = 0;
        processScheduled = false;
        return;
      }
      if (root) pendingRoots.push(root);
      if (processScheduled) return;
      processScheduled = true;
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = 0;
        processScheduled = false;
        if (!active) return;
        if (!isSuiteEnabledNow()) {
          restoreManagedTargets();
          pendingRoots.length = 0;
          return;
        }
        if (!pendingRoots.length) { process(); return; }
        const roots = pendingRoots.splice(0, pendingRoots.length);
        const seen = new Set();
        for (const root of roots) {
          if (!root || seen.has(root) || !root.isConnected) continue;
          seen.add(root);
          process(root);
        }
      });
    };

    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) scheduleProcess(node);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("click", event => {
      if (!isSuiteEnabledNow() || isModifiedLinkActivation(event)) return;
      const link = event.target.closest?.("a.nowrap");
      if (!link) return;
      // Criteria Search owns ordinary KJV verse links on its results page.
      if (
        location.pathname.toLowerCase() === "/search/search.cfm" &&
        /\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href)
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openBlbDestinationFromContent(link.href);
    }, { capture: true, signal: listenerController.signal });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => process(), {
        once: true,
        signal: listenerController.signal
      });
    } else {
      process();
    }

    // Runtime injection can occur after DOMContentLoaded. Wait for the
    // authoritative initial settings read, then process the already-existing
    // BLB links without requiring the user to reload the page.
    Promise.resolve(suiteSettingsReadyPromise).catch(() => {}).then(() => {
      settingsReady = true;
      if (!active) return;
      if (isSuiteEnabledNow()) scheduleProcess();
      else restoreManagedTargets();
    });

    return Object.freeze({
      refresh() {
        if (!active) return;
        if (!isSuiteEnabledNow()) {
          restoreManagedTargets();
          pendingRoots.length = 0;
          if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
          scheduledFrame = 0;
          processScheduled = false;
          return;
        }
        scheduleProcess();
      },
      cleanup
    });
  }

  global.BLBVerseLinkNavigationModule = { initialize };
})(globalThis);
