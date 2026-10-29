// Floating Show on BLB page-selection control and its lifecycle.
(function (global) {
  function initialize({ BLBShared, BOOKS, BOOK_ALIASES, KJV_CORPUS_WORD_INDEX, canonicalStrongValue, resolveBibleReference, resolveBibleBook, resolveBibleReferenceText, normalizeSelectionText, normalizeDoubleClickToken, getContextualBibleReference, safeRuntimeSendMessage, isSensitiveSiteHostname, getSiteDefaultEnabled, refreshDoubleClickBlb, suiteSettingsReadyPromise, isSuiteEnabledNow, makeBlbMultiVerseButtonDraggable, getPageSelectionSiteKey }) {
    // ---------- Floating page selection button ----------
    // This feature is intentionally dormant unless the user enables "Show on BLB".
    // Alt+B and right-click remain independent entry points.
    const BLB_PAGE_BUTTON_ID = 'blb-suite-page-selection-button';
    let blbPageButtonSelection = '';
    let blbPageButtonContextualReference = null;
    let blbPageButtonDirectUrl = null;
    let lastSelectionContextualReference = null;
    let lastSelectionContextualText = '';
    let blbPageButtonVisible = false;
    let pageButtonMonitoring = false;
    let pageButtonSelectionFrame = 0;
    let pageButtonValidationToken = 0;
    let pageButtonActionInProgress = false;
    let pageButtonDomObserver = null;
    let pageButtonDomValidationFrame = 0;
    
    function isBlbPageButtonExcludedSite() {
      const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
      // Exclude only BLB subdomains other than the main hostname. Ordinary external
      // sites must remain eligible when Show on BLB is explicitly enabled.
      return host !== BLBShared.hostnames.blb && host.endsWith('.' + BLBShared.hostnames.blb);
    }
    
    
    function getSelectedPageText() {
      try {
        return normalizeSelectionText(window.getSelection?.().toString() || '');
      } catch (_) {
        return '';
      }
    }
    
    
    // Fast, local structural check for Bible references. This avoids making the
    // floating button depend on a background-service response for an unambiguous
    // reference such as "John 3:16". Phrase/topic selections still use the
    // background KJV verification path below.
    function hasLocalValidBibleReference(text) {
      // Keep the user's selection untouched elsewhere; normalize styled Unicode
      // only for this fast local reference check.
      const source = normalizeSelectionText(text)
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
      if (!source) return false;
      if (canonicalStrongValue(source)) return true;
    
      const entries = [];
      const seen = new Set();
      const add = (name, book) => {
        const value = String(name || '').trim();
        if (!value || !book || seen.has(value.toLowerCase())) return;
        seen.add(value.toLowerCase());
        entries.push({name:value, book});
      };
    
      for (const book of BOOKS) {
        add(book.name, book);
        add(book.urlKey, book);
        if (book.bookNumber) add(book.bookNumber, book);
      }
      for (const [alias, target] of Object.entries(BOOK_ALIASES)) {
        const book = BOOKS.find(b => b.name === target);
        if (book) add(alias, book);
      }
    
      entries.sort((a,b) => b.name.length - a.name.length);
      for (const entry of entries) {
        const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const re = new RegExp(`(?:^|[^A-Za-z0-9])${escaped}\\.?\\s+(-?\\d+)(?:(?::|\\.)\\s*(-?\\d+)(?:\\s*[-–]\\s*(-?\\d+))?|\\s+(-?\\d+)(?:\\s*[-–]\\s*(-?\\d+))?)?(?=$|[^A-Za-z0-9])`, 'i');
        const match = re.exec(source);
        if (!match) continue;
    
        const chapter = Number(match[1]);
        const verse = match[2] ? Number(match[2]) : (match[4] ? Number(match[4]) : null);
        const verseTo = match[3] ? Number(match[3]) : (match[5] ? Number(match[5]) : null);
        // Use the same shared canonical resolver as Omnibox, Alt+B, right-click,
        // and the background selection path. This keeps the floating button in
        // sync with the generic 66-book chapter/verse boundary rules, including
        // out-of-range clamping such as Rev 26:1 -> Rev 22:1.
        const resolved = resolveBibleReference(entry.book.name, chapter, verse, verseTo);
        if (resolved) return true;
      }
    
      // A complete Bible book name by itself is also actionable. The entire
      // selection must be the book name; merely mentioning a book inside a
      // larger sentence or article must not activate the button.
      for (const entry of entries) {
        const normalizeBook = value => String(value || '')
          .replace(/[\u00a0\u2007\u202f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
          .replace(/[.]/g, '');
        if (normalizeBook(source) === normalizeBook(entry.name)) return true;
      }
    
    
      return false;
    }
    
    function stopBlbPageSelectionDomObserver() {
      // A queued validation belongs to the visibility/selection state that
      // scheduled it. Do not let it run after the observer is stopped and the
      // button is subsequently shown for a different keyboard selection.
      if (pageButtonDomValidationFrame) {
        cancelAnimationFrame(pageButtonDomValidationFrame);
        pageButtonDomValidationFrame = 0;
      }
      if (!pageButtonDomObserver) return;
      pageButtonDomObserver.disconnect();
      pageButtonDomObserver = null;
    }
    
    function syncBlbPageSelectionDomObserver() {
      // Observe only while there is a visible action whose cached selection needs
      // protection. Hidden-button pages should not pay for document-wide mutation
      // notifications.
      if (!pageButtonMonitoring || !blbPageButtonVisible || !document.documentElement) {
        stopBlbPageSelectionDomObserver();
        return;
      }
      if (!pageButtonDomObserver) {
        pageButtonDomObserver = new MutationObserver(() => {
          // Mutation callbacks can run between DOM updates that belong to one
          // selection change. Validate once the browser has settled the frame.
          if (pageButtonDomValidationFrame) return;
          pageButtonDomValidationFrame = requestAnimationFrame(() => {
            pageButtonDomValidationFrame = 0;
            validateBlbPageSelectionAfterDomMutation();
          });
        });
      }
      pageButtonDomObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
    
    function invalidateBlbPageSelectionButton() {
      blbPageButtonSelection = '';
      blbPageButtonContextualReference = null;
      blbPageButtonDirectUrl = null;
      lastSelectionContextualReference = null;
      lastSelectionContextualText = '';
      blbPageButtonVisible = false;
      stopBlbPageSelectionDomObserver();
      const button = document.getElementById(BLB_PAGE_BUTTON_ID);
      if (button) button.style.display = 'none';
      // Do not expose a stale selection to the context-menu entry.
    }
    
    // A page can replace or rewrite selected DOM without dispatching input,
    // keyboard, or pointer events. If that happens, the native Selection can
    // continue to reference detached nodes and the floating action must be
    // invalidated instead of acting on cached text from the old document content.
    function validateBlbPageSelectionAfterDomMutation() {
      if (!pageButtonMonitoring || !blbPageButtonVisible) return;
      try {
        const selection = window.getSelection?.();
        if (!selection || selection.rangeCount === 0) {
          invalidateBlbPageSelectionButton();
          return;
        }
        const range = selection.getRangeAt(0);
        const currentText = normalizeSelectionText(selection.toString());
        const cachedText = normalizeSelectionText(blbPageButtonSelection);
        if (!range.startContainer?.isConnected || !range.endContainer?.isConnected ||
            !currentText || currentText !== cachedText) {
          invalidateBlbPageSelectionButton();
        }
      } catch (_) {
        invalidateBlbPageSelectionButton();
      }
    }
    
    function setBlbPageButtonVisible(visible) {
      blbPageButtonVisible = !!visible;
      const button = document.getElementById(BLB_PAGE_BUTTON_ID);
      if (button) button.style.display = blbPageButtonVisible ? 'block' : 'none';
      syncBlbPageSelectionDomObserver();
      // Keep the right-click Show on BLB item synchronized with the exact same
      // live eligibility state. The background handler also receives tab context
      // through sender.tab, so no separate classifier is needed here.
    }
    
    function removeBlbPageSelectionButton() {
      setBlbPageButtonVisible(false);
      const button = document.getElementById(BLB_PAGE_BUTTON_ID);
      button?.__blbDragVisibilityObserver?.disconnect();
      document.getElementById(BLB_PAGE_BUTTON_ID + '-reset-position')?.remove();
      button?.remove();
      blbPageButtonSelection = '';
    }
    
    function addBlbPageSelectionButton() {
      if (document.getElementById(BLB_PAGE_BUTTON_ID) || isBlbPageButtonExcludedSite()) return;
      // document.documentElement is available at document_start; do not require
      // document.body, because many sites create it later.
      const mount = document.documentElement || document.body;
      if (!mount) return;
    
      const button = document.createElement('button');
      button.id = BLB_PAGE_BUTTON_ID;
      button.type = 'button';
      button.textContent = 'Show on BLB';
      button.title = 'Open the selected Bible text or references in BLB (Alt+B)';
      button.setAttribute('aria-label', 'Show on BLB');
      const isWebsterPage = location.hostname.toLowerCase() === 'webstersdictionary1828.com';
      const buttonBottom = isWebsterPage ? 'bottom:68px' : 'bottom:20px';
      button.style.cssText = [
        'position:fixed !important','right:20px',buttonBottom,'z-index:2147483647 !important','max-width:calc(100vw - 40px) !important',
        'display:none','padding:9px 13px','border-radius:7px',
        'background:#292a2d','color:#f1f3f4','border:1px solid #505257','font:600 13px Arial,sans-serif',
        'line-height:1.2','cursor:pointer','box-shadow:0 2px 8px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08)',
        'transition:transform .12s ease,box-shadow .12s ease,background .12s ease',
        'user-select:none'
      ].join(';');
    
      button.addEventListener('mouseenter', () => { button.style.background='#303136'; button.style.transform='translateY(-1px)'; button.style.boxShadow='0 4px 12px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.1)'; });
      button.addEventListener('mouseleave', () => { button.style.background='#292a2d'; button.style.transform='translateY(0)'; button.style.boxShadow='0 2px 8px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08)'; });
      button.addEventListener('mousedown', () => { button.style.transform='translateY(1px)'; button.style.boxShadow='0 1px 3px rgba(0,0,0,.38),inset 0 1px 2px rgba(0,0,0,.22)'; });
      button.addEventListener('mouseup', () => { button.style.transform='translateY(-1px)'; button.style.boxShadow='0 4px 12px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.1)'; });
    
      button.addEventListener('mousedown', e => {
        // Preserve the page selection while the floating control is clicked.
        // The document-level selection handlers must not treat this as a new
        // selection gesture.
        e.preventDefault();
        e.stopPropagation();
        pageButtonActionInProgress = true;
      });
      button.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const text = blbPageButtonSelection || getSelectedPageText();
        if (!text || !isSuiteEnabledNow()) {
          pageButtonActionInProgress = false;
          return;
        }
        // Ignore stale content-script contexts if the extension was reloaded.
        safeRuntimeSendMessage({
          type:'blbSuiteOpenSelectionText',
          text,
          contextualReference: blbPageButtonContextualReference || null,
          directUrl: blbPageButtonDirectUrl || null,
          // A single-token floating-button action should follow the same fast path
          // as double-click: do not re-scan page context after the selection has
          // already been accepted as a word. Multi-word selections still resolve
          // adjacent references through the normal background path.
          // Only mark context as resolved when the button actually has a
          // contextual reference. A standalone alias such as "Jn" must still
          // reach the shared background resolver, which handles book aliases
          // and can recover nearby verse context if the local fast path missed it.
          contextualReferenceResolved: !!blbPageButtonContextualReference,
          tabBehavior:{activeIfNew:true,activateExisting:true}
        });
        clearBlbPageSelectionAfterAction();
        setTimeout(() => { pageButtonActionInProgress = false; }, 0);
      });
    
      mount.appendChild(button);
      makeBlbMultiVerseButtonDraggable(button, {
        positionKey: 'blbSuiteShowOnBLBButtonPosition',
        defaultRight: 20,
        defaultBottom: isWebsterPage ? 68 : 20
      });
    }
    
    async function updateBlbPageSelectionButtonFromSelection() {
      if (!pageButtonMonitoring || isBlbPageButtonExcludedSite() || isSensitiveSiteHostname(location.hostname)) return;
      let button = document.getElementById(BLB_PAGE_BUTTON_ID);
      if (!button) {
        addBlbPageSelectionButton();
        button = document.getElementById(BLB_PAGE_BUTTON_ID);
      }
      if (!button) return;
    
      const text = getSelectedPageText();
      blbPageButtonSelection = text;
      blbPageButtonContextualReference = null;
      blbPageButtonDirectUrl = null;
      setBlbPageButtonVisible(false);
      if (!text || !isSuiteEnabledNow()) return;
    
      // Match the Double-Click BLB fast-reject rule for single-word selections.
      // Hide the floating button for non-ASCII tokens and English words absent
      // from the local KJV vocabulary, while allowing KJV words and book names.
      if (!/\s/.test(text) && /[^\x00-\x7F]/.test(text)) {
        blbPageButtonSelection = '';
        return;
      }
      if (/^[A-Za-z][A-Za-z'’\\-]*$/.test(text)) {
        const token = normalizeDoubleClickToken(text).replace(/’/g, "'");
        const isKjvWord = typeof KJV_CORPUS_WORD_INDEX !== 'undefined'
          && KJV_CORPUS_WORD_INDEX.has(token);
        const isBookName = !!resolveBibleBook(text);
        if (!isKjvWord && !isBookName) {
          blbPageButtonSelection = '';
          return;
        }
      }
    
      if (text) {
        // Fast path: an exact single reference can be resolved locally once while
        // the selection is being classified. Retain its validated BLB URL so the
        // click does not repeat selection classification in the background worker.
        const directRefs = resolveBibleReferenceText(normalizeSelectionText(text));
        if (directRefs.length === 1) {
          const direct = directRefs[0];
          const selectedNormalized = normalizeSelectionText(text).replace(/\s+/g, ' ').trim();
          const referenceNormalized = normalizeSelectionText(direct.text || '').replace(/\s+/g, ' ').trim();
          if (selectedNormalized && referenceNormalized === selectedNormalized && direct.url) {
            const contextual = {
              book: direct.book,
              chapter: direct.chapter,
              from: direct.from,
              to: direct.to,
              url: direct.url
            };
            blbPageButtonContextualReference = contextual;
            blbPageButtonDirectUrl = direct.url;
            lastSelectionContextualReference = contextual;
            lastSelectionContextualText = text;
          }
        }
        if (!blbPageButtonContextualReference) {
          const contextual = getContextualBibleReference(text);
          if (contextual?.url) {
            blbPageButtonContextualReference = contextual;
            lastSelectionContextualReference = contextual;
            lastSelectionContextualText = text;
          }
        }
      }
      // Show the floating control for accepted selections, including multiword
      // text and partial references that need the shared background resolver.
      setBlbPageButtonVisible(true);
    }
    
    function scheduleFinalBlbPageSelectionButtonUpdate() {
      if (!pageButtonMonitoring) return;
      if (pageButtonSelectionFrame) cancelAnimationFrame(pageButtonSelectionFrame);
      // Let the browser finish applying the selection boundary update before we
      // read document.getSelection(). This avoids validating a stale range.
      setTimeout(() => {
        if (!pageButtonMonitoring) return;
        pageButtonSelectionFrame = requestAnimationFrame(() => {
          pageButtonSelectionFrame = 0;
          updateBlbPageSelectionButtonFromSelection().catch(()=>{});
        });
      }, 0);
    }
    
    function handleBlbPageSelectionMouseDown(event) {
      if (!pageButtonMonitoring || pageButtonActionInProgress) return;
      if (event?.target instanceof Element && event.target.closest(`#${BLB_PAGE_BUTTON_ID}, #${BLB_PAGE_BUTTON_ID}-reset-position`)) return;
      // Preserve an existing selection for the native right-click menu.
      if (event?.button === 2) return;
      invalidateBlbPageSelectionButton();
    }
    
    function handleBlbPageSelectionKeyDown() {
      if (!pageButtonMonitoring) return;
      invalidateBlbPageSelectionButton();
    }
    
    function handleBlbPageSelectionMouseUp() {
      if (!pageButtonMonitoring) return;
      scheduleFinalBlbPageSelectionButtonUpdate();
    }
    
    function handleBlbPageSelectionKeyUp() {
      if (!pageButtonMonitoring) return;
      scheduleFinalBlbPageSelectionButtonUpdate();
    }
    
    const PAGE_BUTTON_HANDLERS_GUARD = '__blbSuitePageButtonHandlersV2';
    function enableBlbPageButtonMonitoring() {
      if (pageButtonMonitoring || isBlbPageButtonExcludedSite() || isSensitiveSiteHostname(location.hostname) || !isSuiteEnabledNow()) return;
      try {
        const previous = window[PAGE_BUTTON_HANDLERS_GUARD];
        if (previous && typeof previous === 'object') {
          for (const [eventName, handler] of Object.entries(previous)) {
            if (typeof handler === 'function') document.removeEventListener(eventName, handler, true);
          }
        }
        window[PAGE_BUTTON_HANDLERS_GUARD] = {
          mousedown: handleBlbPageSelectionMouseDown,
          keydown: handleBlbPageSelectionKeyDown,
          mouseup: handleBlbPageSelectionMouseUp,
          keyup: handleBlbPageSelectionKeyUp
        };
      } catch (_) {}
      pageButtonMonitoring = true;
      // The observer is armed by setBlbPageButtonVisible(true), not for the
      // entire time this feature is enabled.
      syncBlbPageSelectionDomObserver();
      document.addEventListener('mousedown', handleBlbPageSelectionMouseDown, true);
      document.addEventListener('keydown', handleBlbPageSelectionKeyDown, true);
      document.addEventListener('mouseup', handleBlbPageSelectionMouseUp, true);
      document.addEventListener('keyup', handleBlbPageSelectionKeyUp, true);
      addBlbPageSelectionButton();
      // Synchronize the native right-click item immediately with the same
      // site-based setting that controls this floating button. This prevents the
      // first right-click after page load from seeing stale visibility from the
      // previously active tab.
      safeRuntimeSendMessage({type:'blbSuiteSyncSelectionContextMenu'});
      // A fresh page must not inherit a stale right-click item from the previous
      // document. The floating button starts hidden until a valid selection exists.
      setBlbPageButtonVisible(false);
      // A selection can be made before asynchronous site settings finish loading,
      // while the page-button listeners are not attached yet. Reconcile the live
      // selection after monitoring starts so that an early mouseup is not lost.
      scheduleFinalBlbPageSelectionButtonUpdate();
    }
    
    function disableBlbPageButtonMonitoring() {
      pageButtonValidationToken++;
      stopBlbPageSelectionDomObserver();
      if (pageButtonSelectionFrame) {
        cancelAnimationFrame(pageButtonSelectionFrame);
        pageButtonSelectionFrame = 0;
      }
      if (pageButtonMonitoring) {
        document.removeEventListener('mousedown', handleBlbPageSelectionMouseDown, true);
        document.removeEventListener('keydown', handleBlbPageSelectionKeyDown, true);
        document.removeEventListener('mouseup', handleBlbPageSelectionMouseUp, true);
        document.removeEventListener('keyup', handleBlbPageSelectionKeyUp, true);
        pageButtonMonitoring = false;
      }
      removeBlbPageSelectionButton();
    }
    
    function clearBlbPageSelectionAfterAction() {
      // Hide synchronously before clearing the native selection; otherwise the
      // selectionchange observer can briefly re-show the floating button.
      setBlbPageButtonVisible(false);
      blbPageButtonSelection = '';
      blbPageButtonContextualReference = null;
      blbPageButtonDirectUrl = null;
      lastSelectionContextualReference = null;
      lastSelectionContextualText = '';
      try { window.getSelection?.()?.removeAllRanges(); } catch (_) {}
    }
    
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === 'blbSuiteClearPageSelection') {
        clearBlbPageSelectionAfterAction();
        sendResponse({ok:true});
        return;
      }
      if (message?.type === 'blbSuiteRefreshSiteFeatures') {
        Promise.all([
          refreshBlbPageSelectionButton().catch(()=>{}),
          refreshDoubleClickBlb().catch(()=>{})
        ]).then(() => sendResponse({ok:true})).catch(() => sendResponse({ok:false}));
        return true;
      }
      if (message?.type === 'blbSuiteResolveContextualSelection') {
        try {
          const selected = String(message.selectionText || '').trim();
          const cached = lastSelectionContextualText === selected ? lastSelectionContextualReference : null;
          const resolved = cached || getContextualBibleReference(selected);
          sendResponse(resolved ? {ok:true, reference:resolved} : {ok:true, reference:null});
        } catch (_) { sendResponse({ok:true, reference:null}); }
        return true;
      }
      if (message?.type === 'blbSuiteGetPageSelectionVisibility') {
        sendResponse({visible: !!(isSuiteEnabledNow() && pageButtonMonitoring && blbPageButtonVisible)});
        return;
      }
      if (message?.type === 'blbSuiteGetActiveSelectionText') {
        try {
          const selection = window.getSelection?.();
          if (!selection || !selection.rangeCount) {
            sendResponse({ok:true, text:''});
            return;
          }
          const range = selection.getRangeAt(0).cloneRange();
          const blockTags = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DIV','DL','DT','DD','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL']);
          const pieces = [];
          const walk = node => {
            if (node.nodeType === Node.TEXT_NODE) { pieces.push(node.nodeValue || ''); return; }
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') { pieces.push('\n'); return; }
            const isBlock = node.nodeType === Node.ELEMENT_NODE && blockTags.has(node.tagName);
            if (isBlock && pieces.length && !String(pieces[pieces.length - 1]).endsWith('\n')) pieces.push('\n');
            for (const child of node.childNodes) walk(child);
            if (isBlock && pieces.length && !String(pieces[pieces.length - 1]).endsWith('\n')) pieces.push('\n');
          };
          walk(range.cloneContents());
          const reconstructed = pieces.join('').replace(/\u00a0/g, ' ').replace(/[ \\t]*\n[ \\t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
          sendResponse({ok:true, text:reconstructed || selection.toString()});
        } catch (_) {
          sendResponse({ok:true, text:window.getSelection ? window.getSelection().toString() : ''});
        }
        return;
      }
    });
    
    async function refreshBlbPageSelectionButton() {
      try {
        if (isBlbPageButtonExcludedSite() || isSensitiveSiteHostname(location.hostname)) {
          disableBlbPageButtonMonitoring();
          return;
        }
        const siteKey = getPageSelectionSiteKey();
        const data = await chrome.storage.local.get({pageSelectionButtonSites:{}});
        const sites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object'
          ? data.pageSelectionButtonSites
          : {};
        const hasExplicitPreference = Object.prototype.hasOwnProperty.call(sites, siteKey);
        // Show on BLB is site-based. An explicit site setting wins; otherwise the
        // hostname/default-sites rule supplies the site's default (ON or OFF).
        const defaultEnabled = await getSiteDefaultEnabled();
        const shouldEnable = hasExplicitPreference ? sites[siteKey] === true : defaultEnabled;
        // Keep the native context-menu item in lockstep with the exact setting that
        // controls the floating Show on BLB button.
        await safeRuntimeSendMessage({type:'blbSuiteSyncSelectionContextMenu'});
        if (!isSuiteEnabledNow() || !shouldEnable) {
          disableBlbPageButtonMonitoring();
          return;
        }
        enableBlbPageButtonMonitoring();
      } catch (_) {
        // Fail closed if site-feature settings or defaults cannot be read.
        disableBlbPageButtonMonitoring();
        try { await safeRuntimeSendMessage({type:'blbSuiteSyncSelectionContextMenu'}); } catch (_) {}
      }
    }
    
    if (!isBlbPageButtonExcludedSite() && !isSensitiveSiteHostname(location.hostname)) {
      suiteSettingsReadyPromise.then(refreshBlbPageSelectionButton).catch(()=>{});
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { refreshBlbPageSelectionButton().catch(()=>{}); }, {once:true});
      } else {
        setTimeout(() => { refreshBlbPageSelectionButton().catch(()=>{}); }, 0);
      }
    }
    
    
    
    return {
      refresh: refreshBlbPageSelectionButton,
      disable: disableBlbPageButtonMonitoring
    };
  }
  global.BLBPageSelectionButtonModule = { initialize };
})(globalThis);
