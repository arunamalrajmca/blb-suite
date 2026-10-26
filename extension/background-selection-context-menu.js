// Web/PDF selection context-menu policy, visibility synchronization and menu state.
// The service worker retains onActivated/onUpdated/onClicked listener registration.
globalThis.BLBBackgroundSelectionContextMenuModule = Object.freeze({
  create({ chromeApi, blbHostname, isSuiteEnabled, isSensitiveSiteHostname, normalizeSiteHostname, isSiteEnabledByDefault, isHttpPageUrl, hasHostAccessForTab }) {
    const chrome = chromeApi;
    const BLB_HOSTNAME = blbHostname;
    function hostnameFromTabUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return normalizeSiteHostname(u.hostname);
  } catch (_) {
    return '';
  }
}

function pageSelectionSettingKeyFromTab(tab) {
  const raw = String(tab?.url || tab?.pendingUrl || '');
  const title = String(tab?.title || '');
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (_) {}
  const looksPdf = /\.pdf(?:$|[?#&\/])/i.test(decoded) || /\.pdf(?:$|\s)/i.test(title);
  if (/^file:/i.test(raw) && looksPdf) return '__blb_local_pdf__';
  if (/^(?:chrome|brave)-extension:/i.test(raw) && (looksPdf || /pdf/i.test(raw))) return '__blb_pdf_viewer__';
  if (/^(?:brave|chrome):\/\//i.test(raw) && (looksPdf || /pdf/i.test(raw))) return '__blb_pdf_viewer__';
  return hostnameFromTabUrl(raw);
}

function isPdfViewerTab(tab) {
  const key = pageSelectionSettingKeyFromTab(tab);
  return key === '__blb_local_pdf__' || key === '__blb_pdf_viewer__';
}

async function isPageButtonEnabledForHostname(hostname, title = '') {
  const siteKey = normalizeSiteHostname(hostname);
  if (!siteKey || (siteKey !== BLB_HOSTNAME && siteKey.endsWith('.blueletterbible.org'))) return false;
  // Stale preferences must never bypass the sensitive-site policy.
  if (isSensitiveSiteHostname(siteKey)) return false;
  const data = await chrome.storage.local.get({masterEnabled:true, pageSelectionButtonSites:{}});
  if (data.masterEnabled === false) return false;
  const sites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object' ? data.pageSelectionButtonSites : {};
  // Right-click follows the saved Show on BLB setting for this site.
  // Without an explicit preference, the feature is OFF.
  if (siteKey === BLB_HOSTNAME) return sites[siteKey] === true;
  if (Object.prototype.hasOwnProperty.call(sites, siteKey)) return sites[siteKey] === true;
  return isSiteEnabledByDefault(siteKey, title);
}

async function shouldShowBlbContextMenu(tab, selectionText) {
  if (!(await isSuiteEnabled())) return false;
  const siteKey = pageSelectionSettingKeyFromTab(tab);
  // The right-click action is exactly the same site-based feature as the
  // floating Show on BLB button. Do not require a content-script visibility
  // signal or a classifier just to expose the menu item.
  return await isPageButtonEnabledForHostname(siteKey, tab?.title || '');
}

let selectionMenuOperation = Promise.resolve();
let selectionMenuKnownPresent = false;
let pdfSelectionMenuKnownPresent = false;
// Keep only the newest visibility request. Opening a MultiVerse batch can
// produce many tab events; serializing each stale snapshot delays the menu
// update on the page the user is actually viewing.
let webSelectionVisibilitySyncGeneration = 0;

async function ensureWebSelectionContextMenu() {
  if (selectionMenuKnownPresent) return true;
  try {
    // Context-menu visibility can persist across service-worker restarts.
    // Start hidden until the active tab's eligibility has been re-evaluated;
    // otherwise a stale visible=true state can leak onto blueletterbible.org.
    await chrome.contextMenus.update('blb-suite-web-selection', {
      title:'Show on BLB\tAlt+B',
      visible:false
    });
    selectionMenuKnownPresent = true;
    return true;
  } catch (_) {}
  try {
    await chrome.contextMenus.create({
      id:'blb-suite-web-selection',
      title:'Show on BLB\tAlt+B',
      contexts:['selection'],
      documentUrlPatterns:['http://*/*','https://*/*'],
      visible:false
    });
    selectionMenuKnownPresent = true;
    return true;
  } catch (_) {
    selectionMenuKnownPresent = false;
    return false;
  }
}

async function updateSelectionContextMenuVisibility(visible) {
  // Do not rely on contextMenus.onShown for the initial state: by the time
  // onShown runs Chromium may already have snapshotted the native menu. The
  // page content script explicitly asks us to synchronize before exposing
  // the floating button, so this update must be awaited end-to-end.
  const present = await ensureWebSelectionContextMenu();
  if (!present) return false;
  try {
    await chrome.contextMenus.update('blb-suite-web-selection', {visible:!!visible});
    return true;
  } catch (_) {
    return false;
  }
}

async function syncWebSelectionContextMenuVisibility(tab) {
  const generation = ++webSelectionVisibilitySyncGeneration;
  try {
    // Resolve the actual active tab at execution time instead of waiting in
    // the shared PDF/web menu-operation queue behind stale tab snapshots.
    const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
    const activeTab = tabs[0] || tab;
    if (!activeTab) {
      if (generation === webSelectionVisibilitySyncGeneration) {
        await updateSelectionContextMenuVisibility(false);
      }
      return false;
    }
    const visible = await shouldShowBlbContextMenu(activeTab, '');
    // A newer activation/navigation may have started while eligibility was
    // being read. Never let an older result overwrite the latest tab state.
    if (generation !== webSelectionVisibilitySyncGeneration) return false;
    return await updateSelectionContextMenuVisibility(visible);
  } catch (_) {
    if (generation !== webSelectionVisibilitySyncGeneration) return false;
    return await updateSelectionContextMenuVisibility(false);
  }
}

// Keep the web selection menu persistent. Its visibility is synchronized on
// page activation/navigation/site-setting changes and directly by the content
// script before the floating Show on BLB button is exposed. Never remove and
// recreate this item during normal operation.
async function installWebSelectionContextMenu() {
  const operation = selectionMenuOperation.then(async () => {
    return await ensureWebSelectionContextMenu();
  });
  selectionMenuOperation = operation.catch(() => false);
  return operation;
}

async function installPdfSelectionContextMenu() {
  selectionMenuOperation = selectionMenuOperation.then(async () => {
    // Context-menu items persist across service-worker restarts/reloads.
    // Remove our known PDF item first so startup/onChanged/onStartup calls are idempotent.
    try { await chrome.contextMenus.remove('blb-suite-pdf-selection'); } catch (_) {}
    try {
      await chrome.contextMenus.create({
        id:'blb-suite-pdf-selection',
        title:'Show on BLB\tAlt+B',
        contexts:['selection'],
        documentUrlPatterns:['file:///*.pdf'],
        visible:false
      });
      pdfSelectionMenuKnownPresent = true;
    } catch (_) {
      pdfSelectionMenuKnownPresent = false;
    }
  }).catch(() => {});
  return selectionMenuOperation;
}

async function syncPdfSelectionContextMenuVisibility(tab) {
  if (!pdfSelectionMenuKnownPresent) return;
  try {
    const enabled = !!tab && (await isSuiteEnabled()) && isPdfViewerTab(tab) &&
      (await isPageButtonEnabledForHostname(pageSelectionSettingKeyFromTab(tab), tab.title || ''));
    await chrome.contextMenus.update('blb-suite-pdf-selection', {visible: enabled});
  } catch (_) {}
}

    return Object.freeze({
      hostnameFromTabUrl,
      pageSelectionSettingKeyFromTab,
      isPdfViewerTab,
      isPageButtonEnabledForHostname,
      shouldShowBlbContextMenu,
      ensureWebSelectionContextMenu,
      updateSelectionContextMenuVisibility,
      syncWebSelectionContextMenuVisibility,
      installWebSelectionContextMenu,
      installPdfSelectionContextMenu,
      syncPdfSelectionContextMenuVisibility
    });
  }
});
