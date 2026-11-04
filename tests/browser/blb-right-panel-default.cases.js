const { test, expect } = require('./fixtures');

function versePageHtml({ panel = 'collapsed', restoreAfterLoadMs = null } = {}) {
  const panelClass = panel === 'expanded' ? 'bodyColumns' : 'bodyColumns hidden';
  const toggleClass = panel === 'collapsed'
    ? 'site-expand-container right'
    : 'site-expand-container right hidden';
  const restoreScript = restoreAfterLoadMs === null ? '' : `
    window.addEventListener('load', () => {
      window.setTimeout(() => {
        document.getElementById('bodyCol1A')?.classList.add('hidden');
        document.getElementById('siteExpandRight')?.classList.remove('hidden');
      }, ${restoreAfterLoadMs});
    });
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

