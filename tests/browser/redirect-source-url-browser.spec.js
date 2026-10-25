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

const sourcePageMultiVerseStart = contentSource.indexOf('// ---------- Christianity.com and GotQuestions.org MultiVerse collection ----------');
const sourcePageMultiVerseEnd = contentSource.indexOf('// ---------- BLB MultiVerse hand-off ----------', sourcePageMultiVerseStart);
if (sourcePageMultiVerseStart < 0 || sourcePageMultiVerseEnd < 0) {
  throw new Error('Could not locate source-page MultiVerse button implementation');
}
const sourcePageMultiVerseCode = contentSource.slice(sourcePageMultiVerseStart, sourcePageMultiVerseEnd);

async function loadSourcePageMultiVerse(page, sourceUrl) {
  await loadProductionRedirect(page, sourceUrl);
  await page.addScriptTag({ content: 'function normalizeSelectionText(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }' });
  await page.addScriptTag({ content: 'window.chrome = { storage: { local: { get: async () => ({ redirectEnabled: true }) }, onChanged: { addListener: () => {} } }, runtime: { sendMessage: async message => { window.__multiVerseRequests = (window.__multiVerseRequests || []).concat([message]); return { ok: true }; } } };' });
  await page.addScriptTag({ content: sourcePageMultiVerseCode });
  await page.waitForSelector('button[id$="-multiverse"]');
}

test.describe('real-browser source URL redirect regressions', () => {
  for (const source of [
    { host: 'christianity.com', url: 'https://www.christianity.com/wiki/bible/example.html', button: '#blb-suite-christianity-multiverse' },
    { host: 'gotquestions.org', url: 'https://www.gotquestions.org/example-question.html', button: '#blb-suite-gotquestions-multiverse' }
  ]) {
    test(`${source.host} offers a page-wide BLB MultiVerse button for linked Bible references`, async ({ page }) => {
      await loadSourcePageMultiVerse(page, source.url);
      await page.evaluate(() => {
        document.body.insertAdjacentHTML('beforeend', [
          '<a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>',
          '<a href="https://www.biblegateway.com/passage/?search=Romans%208%3A9">Romans 8:9</a>',
          '<a href="https://www.biblegateway.com/passage/?search=John%203%3A16">John 3:16</a>',
          '<a href="/unrelated.html">Read more</a>',
          '<a href="https://www.biblegateway.com/passage/?search=Ephesians%202%3A8-9">Ephesians 2:8-9</a>'
        ].join(' '));
      });
      await page.locator(source.button).click();
      await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(1);
      const request = await page.evaluate(() => window.__multiVerseRequests[0]);
      expect(request.type).toBe('blbSuiteOpenWebsterMultiVerse');
      expect(request.refs.map(ref => ref.text)).toEqual(['John 3:16', 'Romans 8:9', 'Ephesians 2:8-9']);
      expect(request.refs.map(ref => ref.url)).toEqual([
        'https://www.blueletterbible.org/kjv/jhn/3/16/',
        'https://www.blueletterbible.org/kjv/rom/8/9/',
        'https://www.blueletterbible.org/kjv/eph/2/8-9/'
      ]);
      expect(request.refs.every(ref => ref.version === 'kjv')).toBe(true);
      await expect(page).toHaveURL(source.url);
    });
  }

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

  test('Christianity.com click guard resolves chapter, single-verse, and verse-range links to KJV', async ({ page }) => {
    await loadProductionRedirect(page, 'https://www.christianity.com/faith/bible-study/article.html');
    await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => true);' });
    await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
    const cases = [
      {
        href: 'https://www.christianity.com/bible/niv/ephesians/2',
        expected: 'https://www.blueletterbible.org/kjv/eph/2/1/'
      },
      {
        href: 'https://www.christianity.com/bible/esv/john/3-16',
        expected: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
      },
      {
        href: 'https://www.christianity.com/bible/ylt/john/3-16-18?source=article#verse',
        expected: 'https://www.blueletterbible.org/kjv/jhn/3/16-18/'
      },
      {
        href: 'https://www.christianity.com/bible/kjv/1-corinthians/13-4-7',
        expected: 'https://www.blueletterbible.org/kjv/1co/13/4-7/'
      }
    ];
    for (const [index, item] of cases.entries()) {
      await page.evaluate(({ href, index }) => {
        const anchor = document.createElement('a');
        anchor.id = 'passage-' + index;
        anchor.href = href;
        anchor.textContent = 'Bible passage';
        document.body.appendChild(anchor);
      }, { href:item.href, index });
      await page.locator('#passage-' + index).evaluate(anchor => {
        anchor.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, button:0 }));
      });
      await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBe(item.expected);
      await expect(page).toHaveURL('https://www.christianity.com/faith/bible-study/article.html');
    }
  });

  test('Christianity.com click guard does not claim a passage when redirect is disabled', async ({ page }) => {
    await loadProductionRedirect(page, 'https://www.christianity.com/faith/bible-study/article.html');
    await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => false);' });
    await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
    const result = await page.evaluate(() => {
      const anchor = document.createElement('a');
      anchor.href = 'https://www.christianity.com/bible/esv/john/3-16';
      document.body.appendChild(anchor);
      const event = new MouseEvent('click', { bubbles:true, cancelable:true, button:0 });
      anchor.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(result).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBeNull();
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
        modifiedCtrl: dispatch('modified', { ctrlKey:true }),
        modifiedMeta: dispatch('modified', { metaKey:true }),
        modifiedShift: dispatch('modified', { shiftKey:true }),
        modifiedAlt: dispatch('modified', { altKey:true }),
        middleButton: dispatch('modified', { button:1 }),
        download: dispatch('download'),
        unknown: dispatch('unknown')
      };
    });
    expect(results.ordinary.prevented).toBe(false);
    expect(results.foreign.prevented).toBe(false);
    expect(results.modifiedCtrl.prevented).toBe(false);
    expect(results.modifiedMeta.prevented).toBe(false);
    expect(results.modifiedShift.prevented).toBe(false);
    expect(results.modifiedAlt.prevented).toBe(false);
    expect(results.middleButton.prevented).toBe(false);
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
