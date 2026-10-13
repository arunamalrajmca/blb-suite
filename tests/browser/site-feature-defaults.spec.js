const { test, expect } = require('./fixtures');

test('hostname text never enables Show on BLB by default', async ({ extensionWorker }) => {
  const hostnames = [
    'bible.com',
    'www.bible.com',
    'mybible.example',
    'bible-host.example.org',
    'blueletterbible.org',
    'example.com'
  ];

  const results = await extensionWorker.evaluate(async (hosts) => {
    const output = {};
    for (const hostname of hosts) {
      output[hostname] = await chrome.runtime.sendMessage({
        type: 'blbSuiteGetDefaultSiteStatus',
        hostname
      });
    }
    return output;
  }, hostnames);

  for (const hostname of hostnames) {
    expect(results[hostname], hostname).toMatchObject({ ok: true, enabled: false });
  }
});


test('sensitive-site feature toggles are blocked even when the user has opted in', async ({ extensionWorker }) => {
  const results = await extensionWorker.evaluate(async () => {
    const cases = [
      'https://secure.bank.example/',
      'https://www.hdfcbank.com/',
      'https://apollohospitals.com/',
      'https://portal.hospital.example/',
      'https://member.insurance.example/',
      'https://example.com/'
    ];
    const output = {};
    for (const origin of cases) {
      output[origin] = await chrome.runtime.sendMessage({
        type: 'blbSuitePrepareSiteFeatureToggle',
        origin,
        feature: 'pageButton',
        otherFeatureEnabled: true
      });
    }
    return output;
  });
  expect(results['https://secure.bank.example/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://www.hdfcbank.com/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://apollohospitals.com/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://portal.hospital.example/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://member.insurance.example/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://example.com/']).not.toMatchObject({ blockedSensitiveSite: true });
});

test('BLB permits Show on BLB only and never enables Double-click', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({masterEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{}});
    const pageButton = await chrome.runtime.sendMessage({
      type:'blbSuitePrepareSiteFeatureToggle',
      origin:'https://www.blueletterbible.org/*',
      feature:'pageButton',
      otherFeatureEnabled:true
    });
    const storedAfterPageButton = await chrome.storage.local.get({pageSelectionButtonSites:{},doubleClickBlbSites:{}});
    const doubleClick = await chrome.runtime.sendMessage({
      type:'blbSuitePrepareSiteFeatureToggle',
      origin:'https://www.blueletterbible.org/*',
      feature:'doubleClick',
      otherFeatureEnabled:true
    });
    return {pageButton,storedAfterPageButton,doubleClick};
  });
  expect(result.pageButton).toMatchObject({ok:true});
  expect(result.storedAfterPageButton.pageSelectionButtonSites['blueletterbible.org']).toBe(true);
  expect(result.storedAfterPageButton.doubleClickBlbSites['blueletterbible.org']).toBe(false);
  expect(result.doubleClick).toMatchObject({ok:false,blockedBlbDoubleClick:true});
});

test('BLB page selection reuses a Criteria search tab and prioritizes references', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    const query = `blb-suite-dedupe-${Date.now()}`;
    const firstSearch = await openBlbPageSelection(query);
    const secondSearch = await openBlbPageSelection(query);
    const tabsAfterSearch = await chrome.tabs.query({});
    const matchingSearchTabs = tabsAfterSearch.filter(tab => {
      try {
        const url = new URL(tab.url || tab.pendingUrl || '');
        return url.hostname.replace(/^www\\./i, '').toLowerCase() === BLB_HOSTNAME
          && url.pathname === '/search/search.cfm'
          && url.searchParams.get('Criteria') === query;
      } catch (_) {
        return false;
      }
    });
    const reference = await openBlbPageSelection('John 3:16');
    const tabsAfterReference = await chrome.tabs.query({});
    const referenceTabs = tabsAfterReference.filter(tab => /\\/kjv\\/john\\/3\\/16\\/?(?:[?#]|$)/i.test(tab.url || tab.pendingUrl || ''));
    return {
      firstSearch,
      secondSearch,
      matchingSearchTabCount: matchingSearchTabs.length,
      reference,
      referenceTabCount: referenceTabs.length
    };
  });
  expect(result.firstSearch).toMatchObject({ok:true,criteriaSearch:true});
  expect(result.secondSearch).toMatchObject({ok:true,criteriaSearch:true,reused:true});
  expect(result.matchingSearchTabCount).toBe(1);
  expect(result.reference).toMatchObject({ok:true,referenceNavigation:true});
  expect(result.referenceTabCount).toBeGreaterThan(0);
});
