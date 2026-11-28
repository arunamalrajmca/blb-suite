// MAIN-world click guard for supported Bible-reference source sites. This script deliberately does
// not resolve Bible references or call extension APIs; it asks the isolated
// content script to handle a candidate passage and cancels native navigation
// only when that script confirms a valid BLB destination.
(() => {
  if (window.__blbSourcePassageClickGuardInstalled) return;
  window.__blbSourcePassageClickGuardInstalled = true;

  window.addEventListener("click", event => {
    const diagnose = state => {
      if (window.__blbSourcePassageClickGuardDiagnostics === true) {
        window.__blbSourcePassageClickGuardLast = state;
      }
    };
    diagnose({stage:'click',button:event.button,metaKey:event.metaKey,ctrlKey:event.ctrlKey,
      shiftKey:event.shiftKey,altKey:event.altKey,targetType:event.target?.constructor?.name || null});
    if (event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return;

    const node = event.target instanceof Element
      ? event.target
      : event.target && event.target.parentElement;
    const anchor = node && node.closest ? node.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download")) return;

    let url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return; }
    const host = location.hostname.toLowerCase().replace(/^www\./, "");
    if (globalThis.BLBSourcePageCollectorSites?.[host]?.mainWorldClickGuard !== true) return;
    const label = String(anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim();
    const targetHost = url.hostname.toLowerCase().replace(/^www\./, "");
    diagnose({stage:'anchor',host,targetHost,href:url.href,path:url.pathname,label,
      registryGuard:globalThis.BLBSourcePageCollectorSites?.[host]?.mainWorldClickGuard === true});
    const isChristianityPassage = host === "christianity.com" &&
      targetHost === "christianity.com" &&
      /^\/bible\/[^/]+\/[^/]+\/\d+(?:-\d+(?:-\d+)?)?\/?$/i.test(url.pathname);
    const isChurchOfJesusChristVerse = host === "churchofjesuschrist.org" &&
      targetHost === "churchofjesuschrist.org" &&
      /^\/study\/scriptures\/(?:ot|nt)\/[^/]+\/\d+\/?$/i.test(url.pathname) &&
      /^p\d+(?:-p?\d+)?$/i.test(url.searchParams.get("id") || "");
    const isMercyHouseVerse = host === "mercyhouseministry.com" &&
      targetHost === "mercyhouseministry.com" &&
      /^\/bible\/?$/i.test(url.pathname) &&
      Boolean(url.searchParams.get("b") && url.searchParams.get("c") &&
        /^\d+(?:[-–]\d+)?$/.test(url.searchParams.get("v") || ""));
    const isSarataVerse = host === "sarata.com" && targetHost === "sarata.com" &&
      /^\/bible\/(?:chapter|verses)\/[^/]+\.\d+\.html$/i.test(url.pathname) &&
      /^#\d+:\d+(?:-\d+)?$/.test(url.hash);
    const isReferenceLabel = /^(?:[1-3]\s*)?[A-Za-z][A-Za-z .'-]*\s+\d+(?::\d+[a-z]?(?:[-–]\d+[a-z]?)?|\s+\d+[a-z]?(?:[-–]\d+[a-z]?)?)?(?:\s*\((?:KJV|NKJV|ESV|NIV|NASB|CSB|NLT|WEB|AMP|RSV|ASV)\))?$/i.test(label);
    const isBlbReferenceDestination = ["rediscover.bible", "sagacityweb.com"].includes(host) &&
      ["blueletterbible.org", "blueletterbible.com"].includes(targetHost) &&
      (/^\/search\/preSearch\.cfm$/i.test(url.pathname) ||
       /^\/kjv\/[^/]+\/\d+(?:\/\d+(?:-\d+)?)?\/?$/i.test(url.pathname));
    diagnose({stage:'candidate',isChristianityPassage,isChurchOfJesusChristVerse,
      isMercyHouseVerse,isSarataVerse,isReferenceLabel,isBlbReferenceDestination});
    if (!isChristianityPassage && !isChurchOfJesusChristVerse &&
        !isMercyHouseVerse && !isSarataVerse && !isReferenceLabel && !isBlbReferenceDestination) return;

    const request = new CustomEvent("blb-suite-source-passage-click", {
      detail: JSON.stringify({ href:url.href, label }),
      cancelable: true
    });
    const handled = !window.dispatchEvent(request);
    diagnose({stage:'dispatched',handled,defaultPrevented:request.defaultPrevented,href:url.href,label});
    if (!handled) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }, true);
})();
