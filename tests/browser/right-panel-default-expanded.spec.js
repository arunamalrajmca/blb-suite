const { test, expect } = require('./fixtures');

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
  ].join('\\n');
  const panelMarkup = hasPanel
    ? '<div id="bodyCol1A" class="bodyColumns' + (panelExpanded ? '' : ' hidden') + '">Parallel Bible</div>'
    : '';
  return '<!doctype html><html><head><script>' +
    'window.__calls = []; window.BLB = { siteResizeToggle(side) {' +
    'window.__calls.push(side); if (side !== "right") return;' +
    'const panel = document.getElementById("bodyCol1A");' +
    'if (panel) panel.classList.toggle("hidden");' +
    'document.getElementById("siteExpandRight").classList.toggle("hidden");' +
    '}};</script></head><body><main>BLB page content</main>' + panelMarkup +
    '<div id="siteExpandLeft" class="site-expand-container left"></div>' +
    '<div id="siteExpandRight" class="site-expand-container right" onclick="BLB.siteResizeToggle(\\'right\\')"></div>' +
    restore +
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
  test('KJV-only mode does not auto-open the BLB Parallel panel on ' + template.name + ' pages', async ({ context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    const page = await openBlbFixture(context, template.path, {
      hasPanel: template.hasPanel,
      panelExpanded: false
    });
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => ({
      calls: window.__calls,
      controlVisible: !document.getElementById('siteExpandRight').classList.contains('hidden'),
      panelExpanded: !!document.getElementById('bodyCol1A') &&
        !document.getElementById('bodyCol1A').classList.contains('hidden')
    }))).toEqual({ calls: [], controlVisible: true, panelExpanded: false });
  });
}

test('saved-layout restoration does not trigger automatic Parallel panel activation', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openBlbFixture(context, '/kjv/gen/1/1/', {
    hasPanel: true,
    restoreMs: 1200,
    panelExpanded: false
  });
  await page.waitForTimeout(1600);
  expect(await page.evaluate(() => ({
    calls: window.__calls,
    panelExpanded: !document.getElementById('bodyCol1A').classList.contains('hidden'),
    controlVisible: !document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({ calls: [], panelExpanded: false, controlVisible: true });
});

test('the global Suite switch OFF leaves the BLB Parallel panel untouched', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: false });
  const page = await openBlbFixture(context, '/lexicon/g25/kjv/tr/0-1/', { hasPanel: false });
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => ({
    calls: window.__calls,
    controlVisible: !document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({ calls: [], controlVisible: true });
});

test('an already-expanded verse panel is not toggled', async ({ context, extensionStorage }) => {
  await extensionStorage.set({ masterEnabled: true });
  const page = await openBlbFixture(context, '/kjv/gen/1/1/', {
    hasPanel: true,
    panelExpanded: true
  });
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => ({
    calls: window.__calls,
    panelExpanded: !document.getElementById('bodyCol1A').classList.contains('hidden'),
    controlVisible: !document.getElementById('siteExpandRight').classList.contains('hidden')
  }))).toEqual({ calls: [], panelExpanded: true, controlVisible: true });
});
