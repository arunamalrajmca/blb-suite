const { expect } = require('./fixtures');

async function removeTabById(extensionWorker, id) {
  if (id == null) return;
  await extensionWorker.evaluate(tabId => chrome.tabs.remove(tabId).catch(() => {}), id);
}

async function waitForBlbTabPath(extensionWorker, expectedPath, timeout = 10000) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '', active: !!tab.active }))
    ));
    match = tabs.find(tab => {
      try {
        const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
        return pathname === expectedPath || pathname.startsWith(expectedPath.replace(/\/$/, '') + '/');
      } catch (_) {
        return false;
      }
    }) || null;
    return !!match;
  }, { timeout }).toBeTruthy();
  return match;
}

async function waitForNewMultiVerseTab(extensionWorker, beforeIds, timeout = 15000) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({
        id:tab.id,
        url:tab.url || '',
        pendingUrl:tab.pendingUrl || ''
      }))
    ));
    match = tabs.find(tab => {
      if (beforeIds.includes(tab.id)) return false;
      return [tab.url,tab.pendingUrl].some(value => {
        try {
          const url = new URL(value);
          return url.hostname === 'www.blueletterbible.org' &&
            (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
             url.searchParams.get('blbSuiteMultiVerse') === '1');
        } catch (_) { return false; }
      });
    }) || null;
    return !!match;
  }, {timeout}).toBeTruthy();
  return match;
}

async function waitForNewBlbTabPathOnEvent(extensionWorker, beforeIds, expectedPath, timeout = 1200) {
  return extensionWorker.evaluate(({ beforeIds, expectedPath, timeout }) => new Promise((resolve, reject) => {
    const before = new Set(beforeIds);
    let settled = false;
    let timer = null;

    const matches = (tab, changedUrl) => {
      if (!tab || tab.id == null || before.has(tab.id)) return null;
      for (const value of [changedUrl, tab.pendingUrl, tab.url]) {
        try {
          const url = new URL(String(value || ''));
          if (url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath) {
            return { id: tab.id, path: url.pathname };
          }
        } catch (_) {}
      }
      return null;
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve(result);
    };

    const onCreated = tab => {
      const result = matches(tab);
      if (result) finish(null, result);
    };
    const onUpdated = (tabId, changeInfo, tab) => {
      const result = matches(tab, changeInfo?.url);
      if (result) finish(null, result);
    };

    // Subscribe before querying so a destination created during the snapshot
    // cannot be missed. The snapshot also covers tabs opened before listeners.
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(() => finish(new Error('Timed out waiting for BLB tab: ' + expectedPath)), timeout);

    chrome.tabs.query({}).then(tabs => {
      if (settled) return;
      for (const tab of tabs) {
        const result = matches(tab);
        if (result) {
          finish(null, result);
          break;
        }
      }
    }).catch(error => finish(error));
  }), { beforeIds, expectedPath, timeout });
}

async function activateBlbTabForPath(extensionWorker, expectedPath, debug = {}) {
  const profileEnabled = process.env.BLB_PROFILE_BROWSER_FIXTURES === '1';
  const profileStartedAt = process.hrtime.bigint();
  const deadline = Date.now() + 10000;
  let pollCount = 0;
  let lastTabs = [];
  while (Date.now() < deadline) {
    pollCount += 1;
    lastTabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '', active: !!tab.active }))
    ));
    const matchingTabs = lastTabs.filter(tab => {
      try {
        const pathname = new URL(String(tab.url || tab.pendingUrl || '')).pathname;
        return pathname === expectedPath || pathname.startsWith(expectedPath.replace(/\/$/, '') + '/');
      } catch (_) {
        return false;
      }
    });
    if (matchingTabs.length) {
      if (profileEnabled) console.log('BLB_POLL_PROFILE ' + JSON.stringify({
        phase: 'activation-poll',
        durationMs: Number(process.hrtime.bigint() - profileStartedAt) / 1e6,
        pollCount,
        expectedPath
      }));
      return matchingTabs.map(tab => tab.id).filter(id => id != null);
    }
    await new Promise(resolve => setTimeout(resolve, Number.isFinite(debug.pollIntervalMs) ? debug.pollIntervalMs : 100));
  }

  if (profileEnabled) console.log('BLB_POLL_PROFILE ' + JSON.stringify({
    phase: 'activation-poll-timeout',
    durationMs: Number(process.hrtime.bigint() - profileStartedAt) / 1e6,
    pollCount,
    expectedPath
  }));
  console.error('Double-click activation failure', {
    fragment: debug.fragment || '',
    selector: debug.selector || '',
    selectedText: debug.selectedText || '',
    expectedPath,
    tabs: lastTabs
  });
  throw new Error(`Timed out waiting for BLB tab: ${expectedPath}`);
}


module.exports = {
  removeTabById,
  waitForBlbTabPath,
  waitForNewMultiVerseTab,
  waitForNewBlbTabPathOnEvent,
  activateBlbTabForPath
};
