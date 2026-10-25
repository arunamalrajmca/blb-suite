const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const contentSource = read('extension/content.js');
const parseStart = contentSource.indexOf('function parseRef(text) {');
const redirectStart = contentSource.indexOf('function redirectBibleSite() {', parseStart);
const redirectEnd = contentSource.indexOf('\nfunction redirectBlbNet() {', redirectStart);
const decodeStart = contentSource.indexOf('function decodeSafe(v) {');
const bookKeyStart = contentSource.indexOf('function bookKey(value) {');
if ([parseStart, redirectStart, redirectEnd, decodeStart, bookKeyStart].some(i => i < 0)) {
  throw new Error('Could not locate production source redirect helpers');
}
const gateStart = contentSource.indexOf('const REDIRECT_HOSTS = new Set([');
const gateEnd = contentSource.indexOf('// ---------- BLB MultiVerse', gateStart);
if (gateStart < 0 || gateEnd < 0) throw new Error('Could not locate production content-side redirect gate');
const productionRedirectHelpers =
  contentSource.slice(bookKeyStart, parseStart) +
  contentSource.slice(parseStart, redirectStart) +
  contentSource.slice(redirectStart, redirectEnd);
const productionRedirectGate = contentSource.slice(gateStart, gateEnd);

async function loadProductionRedirect(page, sourceUrl) {
  const sourceOrigin = new URL(sourceUrl).origin;
  await page.route(sourceOrigin + '/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Source Bible page</title>' })
  );
  await page.route('https://www.blueletterbible.org/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>BLB destination</title>' })
  );
  await page.goto(sourceUrl);
  await page.addScriptTag({ content: read('extension/regex-patterns.js') });
  await page.addScriptTag({ content: 'const BLB_HOSTNAME = BLBShared.hostnames.blb;' });
  await page.addScriptTag({ content: read('extension/books.js') });
  await page.addScriptTag({ content: read('extension/book-aliases.js') });
  await page.addScriptTag({ content: read('extension/reference-core.js') });
  await page.addScriptTag({ content: productionRedirectHelpers });
  // Stub only the extension APIs and unrelated BLB-native handler. The hostname
  // gate and redirectBibleSite() call below are copied verbatim from production.
  await page.addScriptTag({ content: 'window.isSuiteEnabled = async () => true; window.chrome = { storage: { local: { get: async () => ({ redirectEnabled: true }) } } }; function redirectBlbNet() { return false; } function openBlbDestinationFromContent(url) { window.__openedBlbUrl = url; }' });
}

test.describe('real-browser source URL redirect regressions', () => {
  test('King James Bible Online chapter URL navigates to the resolved BLB destination', async ({ page }) => {
    const sourceUrl = 'https://kingjamesbibleonline.org/John-Chapter-3/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/1/';
    await loadProductionRedirect(page, sourceUrl);
    const navigated = page.waitForURL(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: productionRedirectGate });
    await navigated;
    await expect(page).toHaveURL(targetUrl);
  });

  test('King James Bible Online original 1611 chapter URL navigates to the standard BLB KJV destination', async ({ page }) => {
    const sourceUrl = 'https://www.kingjamesbibleonline.org/John-Chapter-1_Original-1611-KJV/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/1/1/';
    await loadProductionRedirect(page, sourceUrl);
    const navigated = page.waitForURL(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: productionRedirectGate });
    await navigated;
    await expect(page).toHaveURL(targetUrl);
  });

  test('Christianity.com article passage click cancels native navigation and opens BLB exactly once', async ({ page }) => {
    const sourceUrl = 'https://www.christianity.com/faith/bible-study/article.html';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    await loadProductionRedirect(page, sourceUrl);
    await page.evaluate(() => {
      // A page listener may preventDefault before the extension sees the click.
      window.addEventListener('click', event => event.preventDefault(), true);
    });
    await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => true);' });
    await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
    await page.evaluate(() => {
      window.__openedBlbCount = 0;
      const originalOpen = window.openBlbDestinationFromContent;
      window.openBlbDestinationFromContent = url => {
        window.__openedBlbCount += 1;
        originalOpen(url);
      };
      document.body.innerHTML = '<article><p>Continue reading the article.</p><a id="bible-passage" href="https://www.christianity.com/bible/esv/john/3-16?ref=article"><span>John 3:16</span></a></article>';
      // This source-site bubble handler would otherwise reload the article tab.
      document.addEventListener('click', () => {
        window.__sourceClickHandlerRan = true;
        location.reload();
      });
    });
    await page.locator('#bible-passage span').click();
    await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBe(targetUrl);
    await expect.poll(() => page.evaluate(() => window.__openedBlbCount)).toBe(1);
    await expect(page).toHaveURL(sourceUrl);
    await expect(page.evaluate(() => window.__sourceClickHandlerRan || false)).resolves.toBe(false);
    await expect(page.locator('article')).toContainText('Continue reading the article.');
  });

  test('Christianity.com passage guard leaves ordinary, foreign, modified, and download clicks alone', async ({ page }) => {
    await loadProductionRedirect(page, 'https://www.christianity.com/faith/bible-study/article.html');
    await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => true);' });
    await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
    const results = await page.evaluate(() => {
      document.body.innerHTML = [
        '<a id="ordinary" href="/faith/about-us/">About us</a>',
        '<a id="foreign" href="https://www.esv.org/John+3%3A16/">John 3:16 ESV</a>',
        '<a id="modified" href="https://www.christianity.com/bible/esv/john/3-16">John 3:16</a>',
        '<a id="download" download href="https://www.christianity.com/bible/esv/john/3-16">Download passage</a>',
        '<a id="unknown" href="https://www.christianity.com/bible/esv/not-a-bible-book/3-16">Unknown book</a>'
      ].join('');
      const dispatch = (id, options = {}) => {
        const anchor = document.getElementById(id);
        const event = new MouseEvent('click', { bubbles:true, cancelable:true, button:0, ...options });
        return { allowed: anchor.dispatchEvent(event), prevented: event.defaultPrevented };
      };
      return {
        ordinary: dispatch('ordinary'),
        foreign: dispatch('foreign'),
        modified: dispatch('modified', { ctrlKey:true }),
        download: dispatch('download'),
        unknown: dispatch('unknown')
      };
    });
    expect(results.ordinary.prevented).toBe(false);
    expect(results.foreign.prevented).toBe(false);
    expect(results.modified.prevented).toBe(false);
    expect(results.download.prevented).toBe(false);
    expect(results.unknown.prevented).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBeNull();
  });

  test('Christianity.com passage opens BLB in a new tab and keeps the source tab', async ({ page }) => {
    const sourceUrl = 'https://www.christianity.com/bible/esv/john/3-16';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    await loadProductionRedirect(page, sourceUrl);
    await page.addScriptTag({ content: productionRedirectGate });
    await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBe(targetUrl);
    await expect(page).toHaveURL(sourceUrl);
  });

  test('Christianity.com homepage does not redirect or open a BLB tab', async ({ page }) => {
    const sourceUrl = 'https://www.christianity.com/';
    await loadProductionRedirect(page, sourceUrl);
    await page.addScriptTag({ content: productionRedirectGate });
    await page.waitForTimeout(100);
    await expect(page).toHaveURL(sourceUrl);
    await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBeNull();
  });

  test('ESV.org homepage does not redirect', async ({ page }) => {
    const sourceUrl = 'https://www.esv.org/';
    await loadProductionRedirect(page, sourceUrl);
    await page.addScriptTag({ content: productionRedirectGate });
    await page.waitForTimeout(100);
    await expect(page).toHaveURL(sourceUrl);
    await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBeNull();
  });

  test('Christianity.com chapter page opens BLB KJV in a new tab without replacing source', async ({ page }) => {
    const sourceUrl = 'https://www.christianity.com/bible/esv/ephesians/2';
    const targetUrl = 'https://www.blueletterbible.org/kjv/eph/2/1/';
    await loadProductionRedirect(page, sourceUrl);
    await page.addScriptTag({ content: productionRedirectGate });
    await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBe(targetUrl);
    await expect(page).toHaveURL(sourceUrl);
  });

  test('ESV.org root-level chapter URL redirects to BLB KJV', async ({ page }) => {
    const sourceUrl = 'https://www.esv.org/Ephesians+2/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/eph/2/1/';
    await loadProductionRedirect(page, sourceUrl);
    const navigated = page.waitForURL(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: productionRedirectGate });
    await navigated;
    await expect(page).toHaveURL(targetUrl);
  });

  test('ESV.org encoded verse URL navigates to BLB KJV', async ({ page }) => {
    const sourceUrl = 'https://www.esv.org/verses/John%2B3%3A16/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    await loadProductionRedirect(page, sourceUrl);
    const navigated = page.waitForURL(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: productionRedirectGate });
    await navigated;
    await expect(page).toHaveURL(targetUrl);
  });

  test('www KJV.site verse URL navigates to the resolved BLB destination', async ({ page }) => {
    const sourceUrl = 'https://www.kjv.site/John-3-16-kjv/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    await loadProductionRedirect(page, sourceUrl);
    const navigated = page.waitForURL(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => redirectBibleSite());
    await navigated;
    await expect(page).toHaveURL(targetUrl);
  });
});
