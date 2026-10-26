// Floating Show on BLB selection-button lifecycle and DOM validation.
// The module owns page-level selection listeners; the extension runtime message
// listener remains in content.js and calls the returned lifecycle API.
globalThis.BLBPageSelectionLifecycleModule = Object.freeze({
  create({ state, documentApi, windowApi, locationApi, ElementCtor, MutationObserverCtor,
    requestAnimationFrameFn, cancelAnimationFrameFn, setTimeoutFn, buttonId,
    normalizeSelectionText, normalizeDoubleClickToken, kjvWordIndex, resolveBibleBook,
    resolveBibleReferenceText, getContextualBibleReference, isSensitiveSiteHostname,
    isBlbPageButtonExcludedSite, getSelectedPageText, makeBlbMultiVerseButtonDraggable,
    safeRuntimeSendMessage }) {
    const document = documentApi;
    const window = windowApi;
    const location = locationApi;
    const Element = ElementCtor;
    const MutationObserver = MutationObserverCtor;
    const requestAnimationFrame = requestAnimationFrameFn;
    const cancelAnimationFrame = cancelAnimationFrameFn;
    const setTimeout = setTimeoutFn;
    const BLB_PAGE_BUTTON_ID = buttonId;
    const KJV_CORPUS_WORD_INDEX = kjvWordIndex;
    function stopBlbPageSelectionDomObserver() {
  // A queued validation belongs to the visibility/selection state that
  // scheduled it. Do not let it run after the observer is stopped and the
  // button is subsequently shown for a different keyboard selection.
  if (state.pageButtonDomValidationFrame) {
    cancelAnimationFrame(state.pageButtonDomValidationFrame);
    state.pageButtonDomValidationFrame = 0;
  }
  if (!state.pageButtonDomObserver) return;
  state.pageButtonDomObserver.disconnect();
  state.pageButtonDomObserver = null;
}

function syncBlbPageSelectionDomObserver() {
  // Observe only while there is a visible action whose cached selection needs
  // protection. Hidden-button pages should not pay for document-wide mutation
  // notifications.
  if (!state.pageButtonMonitoring || !state.blbPageButtonVisible || !document.documentElement) {
    stopBlbPageSelectionDomObserver();
    return;
  }
  if (!state.pageButtonDomObserver) {
    state.pageButtonDomObserver = new MutationObserver(() => {
      // Mutation callbacks can run between DOM updates that belong to one
      // selection change. Validate once the browser has settled the frame.
      if (state.pageButtonDomValidationFrame) return;
      state.pageButtonDomValidationFrame = requestAnimationFrame(() => {
        state.pageButtonDomValidationFrame = 0;
        validateBlbPageSelectionAfterDomMutation();
      });
    });
  }
  state.pageButtonDomObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function invalidateBlbPageSelectionButton() {
  state.blbPageButtonSelection = '';
  state.blbPageButtonContextualReference = null;
  state.blbPageButtonDirectUrl = null;
  state.lastSelectionContextualReference = null;
  state.lastSelectionContextualText = '';
  state.blbPageButtonVisible = false;
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
  if (!state.pageButtonMonitoring || !state.blbPageButtonVisible) return;
  try {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) {
      invalidateBlbPageSelectionButton();
      return;
    }
    const range = selection.getRangeAt(0);
    const currentText = normalizeSelectionText(selection.toString());
    const cachedText = normalizeSelectionText(state.blbPageButtonSelection);
    if (!range.startContainer?.isConnected || !range.endContainer?.isConnected ||
        !currentText || currentText !== cachedText) {
      invalidateBlbPageSelectionButton();
    }
  } catch (_) {
    invalidateBlbPageSelectionButton();
  }
}

function setBlbPageButtonVisible(visible) {
  state.blbPageButtonVisible = !!visible;
  const button = document.getElementById(BLB_PAGE_BUTTON_ID);
  if (button) button.style.display = state.blbPageButtonVisible ? 'block' : 'none';
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
  state.blbPageButtonSelection = '';
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
    state.pageButtonActionInProgress = true;
  });
  button.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const text = state.blbPageButtonSelection || getSelectedPageText();
    if (!text || !state.suiteEnabled) {
      state.pageButtonActionInProgress = false;
      return;
    }
    // Ignore stale content-script contexts if the extension was reloaded.
    safeRuntimeSendMessage({
      type:'blbSuiteOpenSelectionText',
      text,
      contextualReference: state.blbPageButtonContextualReference || null,
      directUrl: state.blbPageButtonDirectUrl || null,
      // A single-token floating-button action should follow the same fast path
      // as double-click: do not re-scan page context after the selection has
      // already been accepted as a word. Multi-word selections still resolve
      // adjacent references through the normal background path.
      contextualReferenceResolved: !state.blbPageButtonContextualReference && !/\\s/.test(text),
      tabBehavior:{activeIfNew:true,activateExisting:true}
    });
    clearBlbPageSelectionAfterAction();
    setTimeout(() => { state.pageButtonActionInProgress = false; }, 0);
  });

  mount.appendChild(button);
  makeBlbMultiVerseButtonDraggable(button, {
    positionKey: 'blbSuiteShowOnBLBButtonPosition',
    defaultRight: 20,
    defaultBottom: isWebsterPage ? 68 : 20
  });
}

async function updateBlbPageSelectionButtonFromSelection() {
  if (!state.pageButtonMonitoring || isBlbPageButtonExcludedSite() || isSensitiveSiteHostname(location.hostname)) return;
  let button = document.getElementById(BLB_PAGE_BUTTON_ID);
  if (!button) {
    addBlbPageSelectionButton();
    button = document.getElementById(BLB_PAGE_BUTTON_ID);
  }
  if (!button) return;

  const text = getSelectedPageText();
  state.blbPageButtonSelection = text;
  state.blbPageButtonContextualReference = null;
  state.blbPageButtonDirectUrl = null;
  setBlbPageButtonVisible(false);
  if (!text || !state.suiteEnabled) return;

  // Match the Double-Click BLB fast-reject rule for single-word selections.
  // Hide the floating button for non-ASCII tokens and English words absent
  // from the local KJV vocabulary, while allowing KJV words and book names.
  if (!/\s/.test(text) && /[^\x00-\x7F]/.test(text)) {
    state.blbPageButtonSelection = '';
    return;
  }
  if (/^[A-Za-z][A-Za-z'’\\-]*$/.test(text)) {
    const token = normalizeDoubleClickToken(text).replace(/’/g, "'");
    const isKjvWord = typeof KJV_CORPUS_WORD_INDEX !== 'undefined'
      && KJV_CORPUS_WORD_INDEX.has(token);
    const isBookName = !!resolveBibleBook(text);
    if (!isKjvWord && !isBookName) {
      state.blbPageButtonSelection = '';
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
        state.blbPageButtonContextualReference = contextual;
        state.blbPageButtonDirectUrl = direct.url;
        state.lastSelectionContextualReference = contextual;
        state.lastSelectionContextualText = text;
      }
    }
    if (!state.blbPageButtonContextualReference) {
      const contextual = getContextualBibleReference(text);
      if (contextual?.url) {
        state.blbPageButtonContextualReference = contextual;
        state.lastSelectionContextualReference = contextual;
        state.lastSelectionContextualText = text;
      }
    }
  }
  // Show the floating control for accepted selections, including multiword
  // text and partial references that need the shared background resolver.
  setBlbPageButtonVisible(true);
}

function scheduleFinalBlbPageSelectionButtonUpdate() {
  if (!state.pageButtonMonitoring) return;
  if (state.pageButtonSelectionFrame) cancelAnimationFrame(state.pageButtonSelectionFrame);
  // Let the browser finish applying the selection boundary update before we
  // read document.getSelection(). This avoids validating a stale range.
  setTimeout(() => {
    if (!state.pageButtonMonitoring) return;
    state.pageButtonSelectionFrame = requestAnimationFrame(() => {
      state.pageButtonSelectionFrame = 0;
      updateBlbPageSelectionButtonFromSelection().catch(()=>{});
    });
  }, 0);
}

function handleBlbPageSelectionMouseDown(event) {
  if (!state.pageButtonMonitoring || state.pageButtonActionInProgress) return;
  if (event?.target instanceof Element && event.target.closest(`#${BLB_PAGE_BUTTON_ID}, #${BLB_PAGE_BUTTON_ID}-reset-position`)) return;
  // Preserve an existing selection for the native right-click menu.
  if (event?.button === 2) return;
  invalidateBlbPageSelectionButton();
}

function handleBlbPageSelectionKeyDown() {
  if (!state.pageButtonMonitoring) return;
  invalidateBlbPageSelectionButton();
}

function handleBlbPageSelectionMouseUp() {
  if (!state.pageButtonMonitoring) return;
  scheduleFinalBlbPageSelectionButtonUpdate();
}

function handleBlbPageSelectionKeyUp() {
  if (!state.pageButtonMonitoring) return;
  scheduleFinalBlbPageSelectionButtonUpdate();
}

const PAGE_BUTTON_HANDLERS_GUARD = '__blbSuitePageButtonHandlersV2';
function enableBlbPageButtonMonitoring() {
  if (state.pageButtonMonitoring || isBlbPageButtonExcludedSite() || isSensitiveSiteHostname(location.hostname) || !state.suiteEnabled) return;
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
  state.pageButtonMonitoring = true;
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
  state.pageButtonValidationToken++;
  stopBlbPageSelectionDomObserver();
  if (state.pageButtonSelectionFrame) {
    cancelAnimationFrame(state.pageButtonSelectionFrame);
    state.pageButtonSelectionFrame = 0;
  }
  if (state.pageButtonMonitoring) {
    document.removeEventListener('mousedown', handleBlbPageSelectionMouseDown, true);
    document.removeEventListener('keydown', handleBlbPageSelectionKeyDown, true);
    document.removeEventListener('mouseup', handleBlbPageSelectionMouseUp, true);
    document.removeEventListener('keyup', handleBlbPageSelectionKeyUp, true);
    state.pageButtonMonitoring = false;
  }
  removeBlbPageSelectionButton();
}

function getPageSelectionSiteKey() {
  let host = String(location.hostname || '').toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

function clearBlbPageSelectionAfterAction() {
  // Hide synchronously before clearing the native selection; otherwise the
  // selectionchange observer can briefly re-show the floating button.
  setBlbPageButtonVisible(false);
  state.blbPageButtonSelection = '';
  state.blbPageButtonContextualReference = null;
  state.blbPageButtonDirectUrl = null;
  state.lastSelectionContextualReference = null;
  state.lastSelectionContextualText = '';
  try { window.getSelection?.()?.removeAllRanges(); } catch (_) {}
}

    return Object.freeze({stopBlbPageSelectionDomObserver, syncBlbPageSelectionDomObserver, invalidateBlbPageSelectionButton, validateBlbPageSelectionAfterDomMutation, setBlbPageButtonVisible, removeBlbPageSelectionButton, addBlbPageSelectionButton, updateBlbPageSelectionButtonFromSelection, scheduleFinalBlbPageSelectionButtonUpdate, handleBlbPageSelectionMouseDown, handleBlbPageSelectionKeyDown, handleBlbPageSelectionMouseUp, handleBlbPageSelectionKeyUp, enableBlbPageButtonMonitoring, disableBlbPageButtonMonitoring, getPageSelectionSiteKey, clearBlbPageSelectionAfterAction});
  }
});
