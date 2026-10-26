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
      'https://chase.com/',
      'https://online.citi.com/',
      'https://portal.mychart.com/',
      'https://member.aetna.com/',
      'https://apollohospitals.com/',
      'https://portal.hospital.example/',
      'https://member.insurance.example/',
      'https://www.gov.scot/',
      'https://www.gov.wales/',
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
  expect(results['https://chase.com/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://online.citi.com/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://portal.mychart.com/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://member.aetna.com/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://apollohospitals.com/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://portal.hospital.example/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://member.insurance.example/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://www.gov.scot/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://www.gov.wales/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
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
        return url.hostname.replace(/^www\./i, '').toLowerCase() === BLB_HOSTNAME
          && url.pathname === '/search/search.cfm'
          && url.searchParams.get('Criteria') === query;
      } catch (_) {
        return false;
      }
    });
    const reference = await openBlbPageSelection('John 3:16');
    const tabsAfterReference = await chrome.tabs.query({});
    const referenceTabs = tabsAfterReference.filter(tab => /\/kjv\/john\/3\/16\/?(?:[?#]|$)/i.test(tab.url || tab.pendingUrl || ''));
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

test('runtime-injected external-site features load shared regex constants before content.js', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const settings = {
      masterEnabled: true,
      pageSelectionButtonSites: {'en.wikipedia.org': true},
      doubleClickBlbSites: {'en.wikipedia.org': true},
      redirectEnabled: false
    };
    return contentScriptFilesForTab({url:'https://en.wikipedia.org/wiki/Grace'}, settings);
  });
  expect(result[0]).toBe('regex-patterns.js');
  expect(result).toContain('content.js');
  expect(result.indexOf('regex-patterns.js')).toBeLessThan(result.indexOf('content.js'));
});



test('stale saved Show on BLB preferences cannot activate context menu on sensitive hosts', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({
      masterEnabled: true,
      pageSelectionButtonSites: {
        'hdfcbank.com': true,
        'apollohospitals.com': true
      },
      doubleClickBlbSites: {}
    });

    const cases = [
      { hostname: 'www.hdfcbank.com', url: 'https://www.hdfcbank.com/' },
      { hostname: 'apollohospitals.com', url: 'https://apollohospitals.com/' },
      { hostname: 'chase.com', url: 'https://chase.com/' },
      { hostname: 'portal.mychart.com', url: 'https://portal.mychart.com/' }
    ];
    const output = [];
    for (const item of cases) {
      output.push({
        hostname: item.hostname,
        directEligibility: await isPageButtonEnabledForHostname(item.hostname),
        contextMenu: await shouldShowBlbContextMenu({ url: item.url, title: 'Test page' }, 'John 3:16')
      });
    }
    return output;
  });

  for (const item of result) {
    expect(item.directEligibility, item.hostname).toBe(false);
    expect(item.contextMenu, item.hostname).toBe(false);
  }
});


test('BLB right-click eligibility follows Show on BLB for the main host but excludes BLB subdomains', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: {
      'blueletterbible.org': true,
      'tools.blueletterbible.org': true,
      'example.com': true
    }
  });

  const result = await extensionWorker.evaluate(async () => ({
    mainBlb: await shouldShowBlbContextMenu({
      url: 'https://www.blueletterbible.org/kjv/jhn/3/16/',
      title: 'Blue Letter Bible'
    }, 'John 3:16'),
    blbSubdomain: await shouldShowBlbContextMenu({
      url: 'https://tools.blueletterbible.org/kjv/jhn/3/16/',
      title: 'BLB tools'
    }, 'John 3:16'),
    externalSite: await shouldShowBlbContextMenu({
      url: 'https://example.com/',
      title: 'Example'
    }, 'John 3:16')
  }));

  expect(result).toEqual({
    mainBlb: true,
    blbSubdomain: false,
    externalSite: true
  });
});

test('a stale saved Double-click preference cannot activate Double-click on BLB pages', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: {},
    doubleClickBlbSites: { 'blueletterbible.org': true }
  });

  // Serve a deterministic document under BLB's real origin so this checks the
  // content script's hostname gate without depending on the live BLB website.
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>BLB test page</title></head><body><p id="blb-host-double-click-target">faith</p></body></html>'
  }));
  await page.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const beforeIds = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await page.locator('#blb-host-double-click-target').dblclick();
  await page.waitForTimeout(500);

  const newTabs = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
    tabs.filter(tab => !before.includes(tab.id)).map(tab => tab.url || tab.pendingUrl || '')
  ), beforeIds);

  expect(newTabs, 'Double-click must not open a BLB search or passage tab on BLB itself').toEqual([]);
});
