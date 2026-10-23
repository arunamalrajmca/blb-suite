const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const contentSource = read('extension/content.js');
const parseStart = contentSource.indexOf('function parseRef(text) {');
const redirectStart = contentSource.indexOf('function redirectBibleSite() {', parseStart);
const redirectEnd = contentSource.indexOf('\nfunction redirectBlbNet() {', redirectStart);
const bookKeyStart = contentSource.indexOf('function bookKey(value) {');
if ([parseStart, redirectStart, redirectEnd, bookKeyStart].some(i => i < 0)) {
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
  await page.addScriptTag({ content: 'window.isSuiteEnabled = async () => true; window.chrome = { storage: { local: { get: async () => ({ redirectEnabled: true }) } } }; function redirectBlbNet() { return false; }' });
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

  test("The King's Bible chapter URL navigates to the matching BLB KJV chapter", async ({ page }) => {
    const sourceUrl = 'https://www.thekingsbible.com/Bible/43/3';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/1/';
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
