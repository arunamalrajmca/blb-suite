const { test, expect } = require('./fixtures');

function blbPageHtml({ panel = 'collapsed', restoreAfterLoadMs = null } = {}) {
  const hasPanel = panel !== 'absent';
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
  <div id="bodyCol1" class="bodyColumns">Left panel</div>
  ${hasPanel ? `<div id="bodyCol1A" class="${panelClass}">Parallel Bible panel</div>` : ''}
  <div id="siteExpandLeft" class="site-expand-container left hidden"></div>
  <div id="siteExpandRight" class="${toggleClass}" onclick="BLB.siteResizeToggle('right')"></div>
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

test('BLB expands a collapsed parallel Bible panel through its own right control', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/kjv/gen/1/1/',
    blbPageHtml({ panel: 'collapsed' })
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


test('BLB late saved-layout restoration cannot collapse the default right panel', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://www.blueletterbible.org/kjv/gen/1/1/',
    blbPageHtml({ panel: 'expanded', restoreAfterLoadMs: 100 })
  );

  await page.waitForFunction(() =>
    document.getElementById('bodyCol1A')?.classList.contains('hidden') === false &&
    window.__rightToggleCalls.length === 1
  );
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    rightPanelClass: document.getElementById('bodyCol1A').className,
    rightControlClass: document.getElementById('siteExpandRight').className
  }));

  expect(result.calls).toEqual(['right']);
  expect(result.rightPanelClass).toBe('bodyColumns');
  expect(result.rightControlClass).toContain('hidden');
});

test('BLB does not toggle an already-expanded panel or pages without a parallel panel', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });

  const expandedPage = await openFixture(
    context,
    'https://www.blueletterbible.org/kjv/gen/1/1/',
    blbPageHtml({ panel: 'expanded' })
  );
  await expandedPage.waitForTimeout(500);
  expect(await expandedPage.evaluate(() => window.__rightToggleCalls)).toEqual([]);
  expect(await expandedPage.locator('#bodyCol1A').getAttribute('class')).toBe('bodyColumns');

  const noPanelPage = await openFixture(
    context,
    'https://www.blueletterbible.org/lexicon/g3088/kjv/tr/0-1/',
    blbPageHtml({ panel: 'absent' })
  );
  await noPanelPage.waitForTimeout(500);
  expect(await noPanelPage.evaluate(() => window.__rightToggleCalls)).toEqual([]);
  expect(await noPanelPage.locator('#siteExpandRight').getAttribute('class')).toContain('hidden');
});

test('right-panel behavior does not run on non-BLB sites', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openFixture(
    context,
    'https://example.com/article',
    blbPageHtml({ panel: 'collapsed' })
  );

  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({
    calls: window.__rightToggleCalls,
    rightPanelClass: document.getElementById('bodyCol1A').className
  }));
  expect(result.calls).toEqual([]);
  expect(result.rightPanelClass).toBe('bodyColumns hidden');
});
