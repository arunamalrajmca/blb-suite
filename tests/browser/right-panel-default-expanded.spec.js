const { test, expect } = require('./fixtures');

test.describe.configure({ mode: 'serial' });

const PAGE_TEMPLATES = [
  { name: 'verse', path: '/kjv/gen/1/1/', hasPanel: true },
  { name: 'MultiVerse', path: '/tools/MultiVerse.cfm', hasPanel: false },
  { name: 'Criteria Search', path: '/search/search.cfm', hasPanel: false },
  { name: 'Lexicon', path: '/lexicon/g25/kjv/tr/0-1/', hasPanel: false },
  { name: 'BLB home', path: '/', hasPanel: false }
];

function blbPageFixture({ hasPanel, restoreMs = null, panelExpanded = false }) {
  const restore = restoreMs === null ? '' : [
    'window.setTimeout(() => {',
    '  const panel = document.getElementById("bodyCol1A");',
    '  if (panel) panel.classList.add("hidden");',
    '  document.getElementById("siteExpandRight").classList.remove("hidden");',
    '}, ' + restoreMs + ');'
  ].join('\n');
  const panelMarkup = hasPanel
    ? '<div id="bodyCol1A" class="bodyColumns' + (panelExpanded ? '' : ' hidden') + '">Parallel Bible</div>'
    : '';
  return '<!doctype html><html><head><script>' +
    'window.__calls = []; window.BLB = { siteResizeToggle(side) {' +
    'window.__calls.push(side); if (side !== "right") return;' +
    'const panel = document.getElementById("bodyCol1A");' +
    'if (panel) panel.classList.remove("hidden");' +
    'document.getElementById("siteExpandRight").classList.add("hidden");' +
    'if (!window.__restoreScheduled) { window.__restoreScheduled = true; ' + restore + ' }' +
    '}};</script></head><body><main>BLB page content</main>' + panelMarkup +
    '<div id="siteExpandLeft" class="site-expand-container left"></div>' +
    '<div id="siteExpandRight" class="site-expand-container right" onclick="BLB.siteResizeToggle(\'right\')"></div>' +
    '</body></html>';
}

async function openBlbFixture(context, pagePath, options) {
  const page = await context.newPage();
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: blbPageFixture(options)
  }));
  await page.goto('https://www.blueletterbible.org' + pagePath);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

for (const template of PAGE_TEMPLATES) {
  test('right panel expands by default on BLB ' + template.name + ' pages', async ({ context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    const page = await openBlbFixture(context, template.path, template);
    await page.waitForFunction(() => window.__calls.length === 1 &&
      document.getElementById('siteExpandRight')?.classList.contains('hidden'));
    expect(await page.evaluate(() => ({
      calls: window.__calls,
      controlHidden: document.getElementById('siteExpandRight').classList.contains('hidden')
    }))).toEqual({ calls: ['right'], controlHidden: true });
    if (template.hasPanel) await expect(page.locator('#bodyCol1A')).not.toHaveClass(/hidden/);
  });
}

test('verse right panel is re-expanded after delayed saved-layout restoration', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openBlbFixture(context, '/kjv/gen/1/1/', { hasPanel: true, restoreMs: 1200 });
  await page.waitForFunction(() => window.__calls.length === 2 &&
    document.getElementById('bodyCol1A')?.classList.contains('hidden') === false, { timeout: 10000 });
  expect(await page.evaluate(() => ({
    calls: window.__calls,
    panelExpanded: !document.getElementById('bodyCol1A').classList.contains('hidden'),
    controlHidden: document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({ calls: ['right', 'right'], panelExpanded: true, controlHidden: true });
});

test('right panel remains untouched when the global Suite switch is OFF', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: false });
  const page = await openBlbFixture(context, '/lexicon/g25/kjv/tr/0-1/', { hasPanel: false });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => ({
    calls: window.__calls,
    controlHidden: document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({ calls: [], controlHidden: false });
});

test('an already-expanded verse panel is not toggled when BLB temporarily leaves the native control visible', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openBlbFixture(context, '/kjv/gen/1/1/', {
    hasPanel: true,
    panelExpanded: true
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => ({
    calls: window.__calls,
    panelExpanded: !document.getElementById('bodyCol1A').classList.contains('hidden'),
    controlVisible: !document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({
    calls: [],
    panelExpanded: true,
    controlVisible: true
  });
});
