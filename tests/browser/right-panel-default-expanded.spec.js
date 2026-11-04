const { test, expect } = require('./fixtures');

function verseFixture(restoreMs = null) {
  const restore = restoreMs === null ? '' : `
    window.setTimeout(() => {
      document.getElementById('bodyCol1A').classList.add('hidden');
      document.getElementById('siteExpandRight').classList.remove('hidden');
    }, ${restoreMs});
  `;
  return `<!doctype html><html><head><script>
    window.__calls = [];
    window.BLB = { siteResizeToggle(side) {
      window.__calls.push(side);
      if (side !== 'right') return;
      document.getElementById('bodyCol1A').classList.remove('hidden');
      document.getElementById('siteExpandRight').classList.add('hidden');
      if (!window.__restoreScheduled) {
        window.__restoreScheduled = true;
        ${restore}
      }
    }};
  </script></head><body>
    <div id="bodyCol1" class="bodyColumns">Main</div>
    <div id="bodyCol1A" class="bodyColumns hidden">Parallel Bible</div>
    <div id="siteExpandLeft" class="site-expand-container left"></div>
    <div id="siteExpandRight" class="site-expand-container right" onclick="BLB.siteResizeToggle('right')"></div>
  </body></html>`;
}

async function openBlbFixture(context, html) {
  const url = 'https://www.blueletterbible.org/kjv/gen/1/1/';
  const page = await context.newPage();
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200, contentType: 'text/html', body: html
  }));
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

test('right-panel test file is discoverable', async () => {
  expect(1).toBe(1);
});

test('verse right panel is re-expanded after delayed saved-layout restoration', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openBlbFixture(context, verseFixture(1200));
  await page.waitForFunction(() =>
    window.__calls.length === 2 &&
    document.getElementById('bodyCol1A')?.classList.contains('hidden') === false,
    { timeout: 10000 }
  );
  expect(await page.evaluate(() => ({
    calls: window.__calls,
    panelExpanded: !document.getElementById('bodyCol1A').classList.contains('hidden'),
    controlHidden: document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({ calls: ['right', 'right'], panelExpanded: true, controlHidden: true });
});
