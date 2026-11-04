const { test, expect } = require('./fixtures');

async function createExtensionMessagePage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

test('hostname text never enables Show on BLB by default', async ({ context, extensionId }) => {
  const messagePage = await createExtensionMessagePage(context, extensionId);
  const hostnames = [
    'bible.com',
    'www.bible.com',
    'mybible.example',
    'bible-host.example.org',
    'blueletterbible.org',
    'example.com'
  ];

  const results = await messagePage.evaluate(async (hosts) => {
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


test('sensitive-site feature toggles are blocked even when the user has opted in', async ({ context, extensionId }) => {
  const messagePage = await createExtensionMessagePage(context, extensionId);
  const results = await messagePage.evaluate(async () => {
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

test('BLB permits Show on BLB only and never enables Double-click', async ({ context, extensionId, extensionWorker }) => {
  const messagePage = await createExtensionMessagePage(context, extensionId);
  await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({masterEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{}});
  });
  const pageButton = await messagePage.evaluate(async () => chrome.runtime.sendMessage({
    type:'blbSuitePrepareSiteFeatureToggle',
    origin:'https://www.blueletterbible.org/*',
    feature:'pageButton',
    otherFeatureEnabled:true
  }));
  const storedAfterPageButton = await extensionWorker.evaluate(async () =>
    chrome.storage.local.get({pageSelectionButtonSites:{},doubleClickBlbSites:{}})
  );
  const doubleClick = await messagePage.evaluate(async () => chrome.runtime.sendMessage({
    type:'blbSuitePrepareSiteFeatureToggle',
    origin:'https://www.blueletterbible.org/*',
    feature:'doubleClick',
    otherFeatureEnabled:true
  }));
  const result = {pageButton,storedAfterPageButton,doubleClick};
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
    const referenceTabs = tabsAfterReference.filter(tab => /\/kjv\/(?:john|jhn)\/3\/16(?:\/|[?#]|$)/i.test(tab.url || tab.pendingUrl || ''));
    return {
      firstSearch,
      secondSearch,
      matchingSearchTabCount: matchingSearchTabs.length,
      reference,
      referenceTabCount: referenceTabs.length
    };
  });
  expect(result.firstSearch).toMatchObject({ok:true,criteriaSearch:true});
  expect(result.secondSearch).toMatchObject({ok:true,criteriaSearch:true});
  // Verify reuse by the browser's actual tab state, not the helper's `reused`
  // field: openBlbDestination returns a Chrome tab object, so that field is not
  // propagated to openBlbPageSelection's result.
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

// Right-panel default regressions use the established site-feature browser spec.
function versePageHtml({ panel = 'collapsed', restoreAfterLoadMs = null } = {}) {
  const panelClass = panel === 'expanded' ? 'bodyColumns' : 'bodyColumns hidden';
  const toggleClass = panel === 'collapsed'
    ? 'site-expand-container right'
    : 'site-expand-container right hidden';
  const restoreScript = restoreAfterLoadMs === null ? '' : `
    window.__scheduleSavedLayoutRestore = () => {
      window.setTimeout(() => {
        document.getElementById('bodyCol1A')?.classList.add('hidden');
        document.getElementById('siteExpandRight')?.classList.remove('hidden');
      }, ${restoreAfterLoadMs});
    };
  `;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <script>
    window.__rightToggleCalls = [];
    window.BLB = {
      siteResizeToggle(side) {
        window.__rightToggleCalls.push(side);
        if (side !== 'right') return;
        document.getElementById('bodyCol1A')?.classList.remove('hidden');
        document.getElementById('siteExpandRight')?.classList.add('hidden');
        if (!window.__savedLayoutRestoreScheduled &&
            typeof window.__scheduleSavedLayoutRestore === 'function') {
          window.__savedLayoutRestoreScheduled = true;
          window.__scheduleSavedLayoutRestore();
        }
      }
    };
  </script>
  <script>${restoreScript}</script>
</head>
<body>
  <div id="bodyCol1" class="bodyColumns">Main / left column</div>
  <div id="bodyCol1A" class="${panelClass}">Parallel Bible panel</div>
  <div id="siteExpandLeft" class="site-expand-container left"></div>
  <div id="siteExpandRight" class="${toggleClass}" onclick="BLB.siteResizeToggle('right')"></div>
</body>
</html>`;
}

// MultiVerse and Criteria Search use the shared BLB page shell, but the
// supplied live markup does not expose #bodyCol1A or a named right-panel
// container. Their real right-side expansion affordance is #siteExpandRight.
function toolPageHtml(kind) {
  const pageContent = kind === 'multiverse'
    ? `
      <div id="mvMain">
        <form id="multiForm"></form>
        <div id="multiResults"></div>
        <div id="byVerseResults"></div>
      </div>`
    : `
      <div id="bubBody">
        <div id="words">
          <div id="interruptDiv"></div>
          <div id="wordsData"><table><tbody id="wordsTbody">
            <tr id="bVerse_gen_1_1"><td>Genesis 1:1</td></tr>
          </tbody></table></div>
        </div>
      </div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <script>
    window.__rightToggleCalls = [];
    window.BLB = {
      siteResizeToggle(side) {
        window.__rightToggleCalls.push(side);
        if (side === 'right') {
          document.getElementById('siteExpandRight')?.classList.add('hidden');
        }
      }
    };
  </script>
</head>
<body>
  <header>
    <div id="pCol-toggleIcon" class="bubHeadIcon"
         data-ev-cat="Bible" data-ev-action="[Parallel] Show"
         data-ev-label="[Parallel] Show" title="Parallel Bible">
      <i class="fa fa-columns"></i>
    </div>
  </header>
  <div id="bodyCol1" class="bodyColumns">${pageContent}</div>
  <div id="siteExpandLeft" class="site-expand-container left" draggable="true"
       onclick="BLB.siteResizeToggle('left')"></div>
  <div id="siteExpandRight" class="site-expand-container right"
       onclick="BLB.siteResizeToggle('right')"></div>
</body>
</html>`;
}

async function openFixture(context, url, html) {
  const parsed = new URL(url);
  const page = await context.newPage();
  await page.route(`${parsed.origin}/**`, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: html
  }));
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

test('BLB expands a collapsed verse-page parallel Bible panel through its native right control', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/kjv/gen/1/1/',
    versePageHtml({ panel: 'collapsed' })
  );

  await page.waitForFunction(() =>
    document.getElementById('bodyCol1A')?.classList.contains('hidden') === false
  );

  const result = await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    leftPanelClass: document.getElementById('bodyCol1').className,
    rightPanelClass: document.getElementById('bodyCol1A').className,
    rightControlClass: document.getElementById('siteExpandRight').className
  }));

  expect(result.calls).toEqual(['right']);
  expect(result.leftPanelClass).toBe('bodyColumns');
  expect(result.rightPanelClass).toBe('bodyColumns');
  expect(result.rightControlClass).toContain('hidden');
});

test('BLB verse panel is re-expanded when a delayed saved-layout restore collapses it', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/kjv/gen/1/1/',
    versePageHtml({ panel: 'collapsed', restoreAfterLoadMs: 1200 })
  );

  await page.waitForFunction(() =>
    window.__rightToggleCalls.length === 2 &&
    document.getElementById('bodyCol1A')?.classList.contains('hidden') === false
  );

  await page.waitForTimeout(300);
  expect(await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    rightPanelExpanded: !document.getElementById('bodyCol1A').classList.contains('hidden'),
    rightControlHidden: document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({
    calls: ['right', 'right'],
    rightPanelExpanded: true,
    rightControlHidden: true
  });
});

test('BLB verse panel state prevents a blind toggle while the native control is temporarily visible', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/kjv/gen/1/1/',
    versePageHtml({ panel: 'expanded' }).replace(
      'site-expand-container right hidden',
      'site-expand-container right'
    )
  );

  await page.waitForTimeout(500);
  expect(await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    rightPanelExpanded: !document.getElementById('bodyCol1A').classList.contains('hidden'),
    rightControlVisible: !document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({
    calls: [],
    rightPanelExpanded: true,
    rightControlVisible: true
  });
});

test('BLB leaves an already-expanded verse panel and pages without a right control unchanged', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });

  const expandedPage = await openFixture(
    context,
    'https://www.blueletterbible.org/kjv/gen/1/1/',
    versePageHtml({ panel: 'expanded' })
  );
  await expandedPage.waitForTimeout(500);
  expect(await expandedPage.evaluate(() => window.__rightToggleCalls)).toEqual([]);
  expect(await expandedPage.locator('#bodyCol1A').getAttribute('class')).toBe('bodyColumns');

  const noControlHtml = `<!doctype html><html><body>
    <div id="bodyCol1" class="bodyColumns">Main column</div>
    <div id="bodyCol1A" class="bodyColumns hidden">No native expand control</div>
  </body></html>`;
  const noControlPage = await openFixture(
    context,
    'https://www.blueletterbible.org/lexicon/g3088/kjv/tr/0-1/',
    noControlHtml
  );
  await noControlPage.waitForTimeout(500);
  expect(await noControlPage.locator('#bodyCol1A').getAttribute('class')).toBe('bodyColumns hidden');
});

test('MultiVerse uses the actual shared BLB right-expand control without assuming a panel ID', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/tools/MultiVerse.cfm',
    toolPageHtml('multiverse')
  );

  await page.waitForFunction(() =>
    window.__rightToggleCalls.length === 1 &&
    document.getElementById('siteExpandRight').classList.contains('hidden')
  );
  expect(await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    left: document.getElementById('bodyCol1').className,
    leftToggleCalls: window.__rightToggleCalls.filter(side => side === 'left').length,
    parallelControl: document.getElementById('pCol-toggleIcon').getAttribute('title'),
    rightControl: document.getElementById('siteExpandRight').className,
    actualContent: Boolean(document.getElementById('mvMain') && document.getElementById('multiForm'))
  }))).toEqual({
    calls: ['right'],
    left: 'bodyColumns',
    leftToggleCalls: 0,
    parallelControl: 'Parallel Bible',
    rightControl: 'site-expand-container right hidden',
    actualContent: true
  }));
});

test('Criteria Search uses the actual shared BLB right-expand control without assuming a panel ID', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/search/search.cfm?Criteria=grace',
    toolPageHtml('criteria')
  );

  await page.waitForFunction(() =>
    window.__rightToggleCalls.length === 1 &&
    document.getElementById('siteExpandRight').classList.contains('hidden')
  );
  expect(await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    left: document.getElementById('bodyCol1').className,
    leftToggleCalls: window.__rightToggleCalls.filter(side => side === 'left').length,
    parallelControl: document.getElementById('pCol-toggleIcon').getAttribute('title'),
    rightControl: document.getElementById('siteExpandRight').className,
    actualContent: Boolean(document.getElementById('bubBody') && document.getElementById('wordsTbody'))
  }))).toEqual({
    calls: ['right'],
    left: 'bodyColumns',
    leftToggleCalls: 0,
    parallelControl: 'Parallel Bible',
    rightControl: 'site-expand-container right hidden',
    actualContent: true
  }));
});

test('enabling the Suite after page load applies the MultiVerse right-panel default', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: false });
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/tools/MultiVerse.cfm',
    toolPageHtml('multiverse')
  );

  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__rightToggleCalls)).toEqual([]);

  await extensionStorage.set({ masterEnabled: true });
  await page.waitForFunction(() =>
    window.__rightToggleCalls.length === 1 &&
    document.getElementById('siteExpandRight').classList.contains('hidden')
  );

  expect(await page.evaluate(() => window.__rightToggleCalls)).toEqual(['right']);
});

test('right-panel behavior does not run on non-BLB sites', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://example.com/article',
    versePageHtml({ panel: 'collapsed' })
  );

  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    rightPanelClass: document.getElementById('bodyCol1A').className
  }));
  expect(result.calls).toEqual([]);
  expect(result.rightPanelClass).toBe('bodyColumns hidden');
});


test('native right-panel expansion is one-shot even when BLB leaves its control visible', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  // Model BLB doing layout work that mutates the document but does not
  // immediately hide #siteExpandRight. The observer must not interpret those
  // mutations as permission to invoke the remote-backed toggle repeatedly.
  const html = toolPageHtml('multiverse').replace(
    "document.getElementById('siteExpandRight')?.classList.add('hidden');",
    "document.documentElement.classList.toggle('blb-layout-pulse');"
  );
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/tools/MultiVerse.cfm',
    html
  );

  await page.waitForFunction(() => window.__rightToggleCalls.length === 1);
  await page.waitForTimeout(700);

  expect(await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    controlStillVisible: !document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({
    calls: ['right'],
    controlStillVisible: true
  });
});

