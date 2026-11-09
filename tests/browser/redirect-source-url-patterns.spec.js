const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const contentSource = read('extension/content.js');
const integrationSourceRedirectModule = read('extension/source-bible-redirect.js').replaceAll('location.replace(target);', 'globalThis.__redirectedTo = target;');
const draggableButtonModule = read('extension/blb-draggable-button.js');
const integrationRedirectStart = contentSource.indexOf('const redirectBibleSite = globalThis.BLBSourceBibleRedirectModule.initialize({');
const sourceHelperStart = contentSource.indexOf('function normalizeBlbDestinationUrl(url) {');
if ([integrationRedirectStart, sourceHelperStart].some(i => i < 0)) throw new Error('Could not locate production source redirect helpers');
const gateStart = contentSource.indexOf('const REDIRECT_HOSTS = new Set([');
const gateEnd = contentSource.indexOf('// MultiVerse hand-off runs as a dedicated feature module.', gateStart);
if (gateStart < 0 || gateEnd < 0) throw new Error('Could not locate production content-side redirect gate');
const productionRedirectHelpers = contentSource.slice(sourceHelperStart, integrationRedirectStart) + integrationSourceRedirectModule + `
globalThis.__sourceBibleRedirect = globalThis.BLBSourceBibleRedirectModule.initialize({
  BLBShared, BOOKS, bookKey, parseChristianityBibleLink, validateSourceBibleReference,
  parseRef, decodeSafe, blbUrl,
  openBlbDestinationFromContent: url => { globalThis.__openedBlbUrl = url; }
});
globalThis.redirectBibleSite = globalThis.__sourceBibleRedirect;`;
// The source URL adapter is exercised directly; production setting/host gating is covered by regression and injection tests.
const productionRedirectGate = 'redirectBibleSite();';

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

const sourcePageMultiVerseCode = read('extension/source-page-collector.js');

async function initializeSourcePageMultiVerse(page) {
  await page.addScriptTag({ content: draggableButtonModule });
  await page.addScriptTag({ content: 'const makeBlbMultiVerseButtonDraggable = globalThis.BLBDraggableButtonModule.makeBlbMultiVerseButtonDraggable;' });
  // The production manifest loads the shared supported-site registry before
  // the collector. Keep this isolated browser harness in the same order.
  await page.addScriptTag({ content: read('extension/source-page-collector-sites.js') });
  await page.addScriptTag({ content: sourcePageMultiVerseCode });
  await page.addScriptTag({ content: `BLBSourcePageCollectorModule.initialize({
    normalizeSelectionText,
    parseRef,
    normalizeSourceBibleBook,
    resolveBibleReference,
    blbUrl,
    formatSourceBibleBookName,
    isSuiteEnabled,
    makeBlbMultiVerseButtonDraggable
  });` });
}

async function loadSourcePageMultiVerse(page, sourceUrl, enabled = true) {
  await loadProductionRedirect(page, sourceUrl);
  await page.addScriptTag({ content: 'function normalizeSelectionText(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }' });
  await page.addScriptTag({ content: 'window.__localStorageValues = window.__localStorageValues || {}; window.isSuiteEnabled = async () => ' + JSON.stringify(enabled) + '; window.chrome = { storage: { local: { get: async defaults => Object.assign({}, defaults || {}, window.__localStorageValues, { redirectEnabled: true }), set: async values => Object.assign(window.__localStorageValues, values), remove: async key => { for (const k of (Array.isArray(key) ? key : [key])) delete window.__localStorageValues[k]; } }, onChanged: { addListener: () => {} } }, runtime: { sendMessage: async message => { window.__multiVerseRequests = (window.__multiVerseRequests || []).concat([message]); return { ok: true }; } } };' });
  await initializeSourcePageMultiVerse(page);
  if (enabled) await page.waitForSelector('button[id$="-multiverse"]');
}

test.describe('real-browser source URL redirect regressions', () => {
  for (const source of [
    { host:'christianity.com', url:'https://www.christianity.com/wiki/bible/example.html', button:'#blb-suite-christianity-multiverse' },
    { host:'gotquestions.org', url:'https://www.gotquestions.org/example-question.html', button:'#blb-suite-gotquestions-multiverse' },
    { host:'crosswalk.com', url:'https://www.crosswalk.com/faith/bible-study/example.html', button:'#blb-suite-crosswalk-multiverse' },
    { host:'enduringword.com', url:'https://www.enduringword.com/bible-commentary/john-3/', button:'#blb-suite-enduringword-multiverse' }
  ]) {
    test(`${source.host} MultiVerse button is absent when the extension is disabled`, async ({ page }) => {
      await loadSourcePageMultiVerse(page, source.url, false);
      await page.waitForTimeout(50);
      await expect(page.locator(source.button)).toHaveCount(0);
    });
  }

  for (const source of [
    { host: 'christianity.com', url: 'https://www.christianity.com/wiki/bible/example.html', button: '#blb-suite-christianity-multiverse' },
    { host: 'gotquestions.org', url: 'https://www.gotquestions.org/example-question.html', button: '#blb-suite-gotquestions-multiverse' },
    { host: 'crosswalk.com', url: 'https://www.crosswalk.com/faith/bible-study/example.html', button: '#blb-suite-crosswalk-multiverse' }
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

  test('Christianity.com MultiVerse collects only current-page references and never follows pagination', async ({ page }) => {
    const sourceUrl = 'https://www.christianity.com/wiki/christian-life/example.html';
    await loadSourcePageMultiVerse(page, sourceUrl);
    await page.evaluate(() => {
      window.__paginationFetchCalls = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        window.__paginationFetchCalls += 1;
        return originalFetch(...args);
      };
      document.body.insertAdjacentHTML('beforeend', `
        <article>
          <a href="https://www.christianity.com/bible/esv/john/3-16">John 3:16</a>
        </article>
        <nav class="pagination" aria-label="Pagination">
          <a href="?page=2" aria-label="Page 2">2</a>
          <a href="?page=2" rel="next" aria-label="Next page">Next</a>
        </nav>`);
    });

    await page.locator('#blb-suite-christianity-multiverse').click();
    await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(1);
    const request = await page.evaluate(() => window.__multiVerseRequests[0]);
    expect(request.refs.map(ref => ref.text)).toEqual(['John 3:16']);
    expect(request.refs.map(ref => ref.url)).toEqual([
      'https://www.blueletterbible.org/kjv/jhn/3/16/'
    ]);
    expect(await page.evaluate(() => window.__paginationFetchCalls)).toBe(0);
    await expect(page).toHaveURL(sourceUrl);
  });

  for (const source of [
    { host: 'gotquestions.org', url: 'https://www.gotquestions.org/example-question.html', button: '#blb-suite-gotquestions-multiverse', fixture: '<article><a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a><a href="https://www.blueletterbible.org/kjv/rom/8/9/">Romans 8:9</a></article>', expected: ['https://www.blueletterbible.org/kjv/jhn/3/16/', 'https://www.blueletterbible.org/kjv/rom/8/9/'] },
    { host: 'crosswalk.com', url: 'https://www.crosswalk.com/faith/bible-study/example.html', button: '#blb-suite-crosswalk-multiverse', fixture: '<article><a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a><a href="https://www.blueletterbible.org/kjv/rom/8/9/">Romans 8:9</a></article>', expected: ['https://www.blueletterbible.org/kjv/jhn/3/16/', 'https://www.blueletterbible.org/kjv/rom/8/9/'] },
    { host: 'enduringword.com', url: 'https://www.enduringword.com/bible-commentary/john-3/', button: '#blb-suite-enduringword-multiverse', fixture: '<aside class="ew-xref"><section class="ew-xref-sec"><h2 class="ew-xref-title">Related Commentary</h2><div class="ew-xref-chips"><a href="https://enduringword.com/bible-commentary/john-3/">John 3</a><a href="https://enduringword.com/bible-commentary/romans-8/">Romans 8</a></div></section></aside>', expected: ['https://www.blueletterbible.org/kjv/jhn/3/1/', 'https://www.blueletterbible.org/kjv/rom/8/1/'] }
  ]) {
    test(`${source.host} MultiVerse collects only current-page references and never follows pagination`, async ({ page }) => {
      await loadSourcePageMultiVerse(page, source.url);
      await page.evaluate(fixture => {
        window.__paginationFetchCalls = 0;
        const originalFetch = window.fetch.bind(window);
        window.fetch = (...args) => {
          window.__paginationFetchCalls += 1;
          return originalFetch(...args);
        };
        document.body.insertAdjacentHTML('beforeend', fixture + `
          <nav class="pagination" aria-label="Pagination">
            <a href="?page=2" aria-label="Page 2">2</a>
            <a href="?page=2" rel="next" aria-label="Next page">Next</a>
          </nav>`);
      }, source.fixture);

      await page.locator(source.button).click();
      await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(1);
      const request = await page.evaluate(() => window.__multiVerseRequests[0]);
      expect(request.refs.map(ref => ref.url)).toEqual(source.expected);
      expect(await page.evaluate(() => window.__paginationFetchCalls)).toBe(0);
      await expect(page).toHaveURL(source.url);
    });
  }

  test('Enduring Word extracts Related Commentary and Referenced By chapters as verse 1, including Psalms', async ({ page }) => {
    const sourceUrl = 'https://www.enduringword.com/bible-commentary/john-3/';
    await loadSourcePageMultiVerse(page, sourceUrl);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', `
        <aside class="ew-xref ew-no-scripture-tag" aria-label="Related commentary in Enduring Word">
          <section class="ew-xref-sec">
            <h2 class="ew-xref-title">Related Commentary <span class="ew-xref-count">2</span></h2>
            <div class="ew-xref-chips">
              <a class="ew-xref-chip" href="https://enduringword.com/bible-commentary/psalm-15/">Psalm 15</a>
              <a class="ew-xref-chip" href="https://enduringword.com/bible-commentary/john-13/">John 13</a>
            </div>
          </section>
          <section class="ew-xref-sec">
            <h2 class="ew-xref-title">Referenced By <span class="ew-xref-count">2</span></h2>
            <div class="ew-xref-chips">
              <a class="ew-xref-chip" href="https://enduringword.com/bible-commentary/genesis-1/">Genesis 1</a>
              <a class="ew-xref-chip" href="https://enduringword.com/bible-commentary/psalm-6/">Psalm 6</a>
            </div>
          </section>
        </aside>`);
    });
    await page.locator('#blb-suite-enduringword-multiverse').click();
    await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(1);
    const request = await page.evaluate(() => window.__multiVerseRequests[0]);
    expect(request.refs.map(ref => ref.text)).toEqual(['Psalms 15:1', 'John 13:1', 'Genesis 1:1', 'Psalms 6:1']);
    expect(request.refs.map(ref => ref.url)).toEqual([
      'https://www.blueletterbible.org/kjv/psa/15/1/',
      'https://www.blueletterbible.org/kjv/jhn/13/1/',
      'https://www.blueletterbible.org/kjv/gen/1/1/',
      'https://www.blueletterbible.org/kjv/psa/6/1/'
    ]);
    await expect(page).toHaveURL(sourceUrl);
  });

  for (const source of [
    { host: 'christianity.com', url: 'https://www.christianity.com/', button: '#blb-suite-christianity-multiverse' },
    { host: 'gotquestions.org', url: 'https://www.gotquestions.org/', button: '#blb-suite-gotquestions-multiverse' },
    { host: 'crosswalk.com', url: 'https://www.crosswalk.com/', button: '#blb-suite-crosswalk-multiverse' },
    { host: 'enduringword.com', url: 'https://www.enduringword.com/', button: '#blb-suite-enduringword-multiverse' }
  ]) {
    test(`${source.host} homepage does not show the MultiVerse button`, async ({ page }) => {
      await loadProductionRedirect(page, source.url);
      await page.addScriptTag({ content: 'function normalizeSelectionText(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }' });
      await page.addScriptTag({ content: 'window.isSuiteEnabled = async () => true; window.chrome = { storage: { local: { get: async () => ({ redirectEnabled: true }) }, onChanged: { addListener: () => {} } }, runtime: { sendMessage: async () => ({ ok: true }) } };' });
      await initializeSourcePageMultiVerse(page);
      await page.waitForTimeout(100);
      await expect(page.locator(source.button)).toHaveCount(0);
      await expect(page).toHaveURL(source.url);
    });
  }

  // Direct chapter/verse URL grammar is covered in redirect-source-url-patterns.spec.js.
  // The browser harness uses a standalone parser rather than the full extension's isolated-world lifecycle.

  test("The King's Bible homepage and Dictionary/Concordance landing pages remain on the source site", async ({ page }) => {
    for (const sourceUrl of [
      'https://www.thekingsbible.com/',
      'https://www.thekingsbible.com/Dictionary/',
      'https://www.thekingsbible.com/Concordance/'
    ]) {
      await loadProductionRedirect(page, sourceUrl);
      await page.addScriptTag({ content: productionRedirectGate });
      await page.waitForTimeout(30);
      await expect(page).toHaveURL(sourceUrl);
      await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBeNull();
    }
  });

  test('King James Bible Online chapter URL navigates to the resolved BLB destination', async ({ page }) => {
    const sourceUrl = 'https://kingjamesbibleonline.org/John-Chapter-3/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/1/';
    await loadProductionRedirect(page, sourceUrl);
    await page.evaluate(() => {
      window.__redirectHarnessError = null;
      try {
        if (typeof window.BLBSourceBibleRedirectModule?.initialize !== 'function') {
          throw new Error('source redirect module was not installed');
        }
        window.__redirectResult = window.__sourceBibleRedirect();
      } catch (error) {
        window.__redirectHarnessError = String(error && (error.stack || error.message) || error);
      }
    });
    await expect.poll(() => page.evaluate(() => ({
      target: window.__redirectedTo || null,
      result: window.__redirectResult ?? null,
      error: window.__redirectHarnessError
    })), {
      message: 'KJBO chapter redirect diagnostic: ' +
        JSON.stringify(await page.evaluate(() => ({
          result: window.__redirectResult,
          error: window.__redirectHarnessError,
          href: location.href,
          module: typeof window.BLBSourceBibleRedirectModule,
          redirect: typeof window.__sourceBibleRedirect,
          shared: Boolean(window.BLBShared),
          books: typeof BOOKS,
          target: window.__redirectedTo
        })))
    }).toMatchObject({ target: targetUrl, error: null });
  });

  test('King James Bible Online original 1611 chapter URL navigates to the standard BLB KJV destination', async ({ page }) => {
    const sourceUrl = 'https://www.kingjamesbibleonline.org/John-Chapter-1_Original-1611-KJV/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/1/1/';
    await loadProductionRedirect(page, sourceUrl);
    await page.addScriptTag({ content: productionRedirectGate });
    await expect.poll(() => page.evaluate(() => window.__redirectedTo || null)).toBe(targetUrl);
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

  for (const source of [
    { host: 'gotquestions.org', url: 'https://www.gotquestions.org/example-question.html' },
    { host: 'crosswalk.com', url: 'https://www.crosswalk.com/faith/bible-study/example.html' },
    { host: 'enduringword.com', url: 'https://enduringword.com/bible-commentary/john-3/' }
  ]) {
    test(`${source.host} passage clicks open BLB and cancel the source site's native click`, async ({ page }) => {
      const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
      await loadProductionRedirect(page, source.url);
      await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => true);' });
      await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
      await page.evaluate(() => {
        document.body.innerHTML = '<article><p>Keep this article open.</p><a id="passage" href="/bible-reference">John 3:16</a></article>';
        document.addEventListener('click', () => { window.__nativeClickRan = true; location.reload(); });
      });
      await page.locator('#passage').click();
      await expect.poll(() => page.evaluate(() => window.__openedBlbUrl || null)).toBe(targetUrl);
      await expect(page).toHaveURL(source.url);
      await expect.poll(() => page.evaluate(() => window.__nativeClickRan || false)).toBe(false);
      await expect(page.locator('article')).toContainText('Keep this article open.');
    });
  }

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
      // The disabled guard must leave the click alone. Prevent the browser's
      // real default navigation only after observing whether the guard claimed it.
      let preventedByGuard = null;
      window.addEventListener('click', event => {
        preventedByGuard = event.defaultPrevented;
        event.preventDefault();
      }, { once:true });
      const anchor = document.createElement('a');
      anchor.href = 'https://www.christianity.com/bible/esv/john/3-16';
      document.body.appendChild(anchor);
      anchor.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, button:0 }));
      return preventedByGuard;
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
        let preventedByGuard = false;
        // Observe the event after the extension's document-level guard has run,
        // then suppress only the browser's native navigation for this test.
        window.addEventListener('click', currentEvent => {
          preventedByGuard = currentEvent.defaultPrevented;
          currentEvent.preventDefault();
        }, { once:true });
        const allowed = anchor.dispatchEvent(event);
        return { allowed, prevented: preventedByGuard };
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

  test('source-page MultiVerse uses data-bible-ref-link when visible caption is abbreviated or unrelated', async ({ page }) => {
    await loadSourcePageMultiVerse(page, 'https://www.christianity.com/faith/bible-study/article.html');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', `
        <article>
          <a href="https://www.bibleref.com/Galatians/3/Galatians-3-11.html"
             data-bible-ref-link="Galatians_3:11|ESV">3:11</a>
          <a href="https://www.bibleref.com/John/3/John-3-16.html"
             data-bible-ref-link="John_3:16|ESV">read more</a>
          <a href="https://www.bibleref.com/Psalms/23/Psalm-23-1.html"
             data-bible-ref-link="Psalm_23:1|NIV">Psalm 23:1</a>
          <a href="https://www.bibleref.com/Romans/8/Romans-8-1.html"
             data-bible-ref-link="Romans_8:1-2|ESV">8:1-2</a>
        </article>`);
    });
    await page.locator('#blb-suite-christianity-multiverse').click();
    await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(1);
    const refs = await page.evaluate(() => window.__multiVerseRequests[0].refs);
    expect(refs.map(ref => ref.url)).toEqual([
      'https://www.blueletterbible.org/kjv/gal/3/11/',
      'https://www.blueletterbible.org/kjv/jhn/3/16/',
      'https://www.blueletterbible.org/kjv/psa/23/1/',
      'https://www.blueletterbible.org/kjv/rom/8/1-2/'
    ]);
    expect(refs.map(ref => ref.text)).toEqual([
      'Galatians 3:11',
      'John 3:16',
      'Psalms 23:1',
      'Romans 8:1-2'
    ]);
  });

  test('source-page MultiVerse normalizes singular Psalm labels to canonical Psalms', async ({ page }) => {
    await loadProductionRedirect(page, 'https://www.christianity.com/faith/bible-study/article.html');
    const normalized = await page.evaluate(() => ({
      singular: normalizeSourceBibleBook('Psalm'),
      plural: normalizeSourceBibleBook('Psalms'),
      caseInsensitive: normalizeSourceBibleBook('PSALM')
    }));
    expect(normalized).toEqual({
      singular: 'Psalms',
      plural: 'Psalms',
      caseInsensitive: 'Psalms'
    });
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
    await page.addScriptTag({ content: productionRedirectGate });
    await expect.poll(() => page.evaluate(() => window.__redirectedTo || null)).toBe(targetUrl);
  });

  test('ESV.org encoded verse URL navigates to BLB KJV', async ({ page }) => {
    const sourceUrl = 'https://www.esv.org/verses/John%2B3%3A16/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    await loadProductionRedirect(page, sourceUrl);
    await page.addScriptTag({ content: productionRedirectGate });
    await expect.poll(() => page.evaluate(() => window.__redirectedTo || null)).toBe(targetUrl);
  });

  test('www KJV.site verse URL navigates to the resolved BLB destination', async ({ page }) => {
    const sourceUrl = 'https://www.kjv.site/John-3-16-kjv/';
    const targetUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    await loadProductionRedirect(page, sourceUrl);
    await page.evaluate(() => redirectBibleSite());
    await expect.poll(() => page.evaluate(() => window.__redirectedTo || null)).toBe(targetUrl);
  });

  test('source-page MultiVerse deduplicates equivalent references and ignores malformed metadata and captions', async ({ page }) => {
    await loadSourcePageMultiVerse(page, 'https://www.crosswalk.com/faith/bible-study/example.html');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', `
        <article>
          <a href="/bible-reference/1" data-bible-ref-link="Romans_8:9|ESV">8:9</a>
          <a href="/bible-reference/2" data-bible-ref-link="Romans_8:9|NIV">Read more</a>
          <a href="/bible-reference/3" data-bible-ref-link="John_3:16-18|ESV">passage</a>
          <a href="/bible-reference/4" data-bible-ref-link="not-a-reference|ESV">not a Bible reference</a>
          <a href="/bible-reference/5" data-bible-ref-link="not-a-reference|ESV">Jude 1:3</a>
          <a href="/bible-reference/6" data-bible-ref-link="John_0:0|ESV">Philemon 1:6</a>
          <a href="/bible-reference/8" data-bible-ref-link="Unknown_999:999|ESV">Titus 2:11</a>
          <a href="/bible-reference/7">read more</a>
          <a href="/bible-reference/7" data-bible-ref-link="John_3:16|ESV" download>John 3:16 download</a>
        </article>`);
    });
    await page.locator('#blb-suite-crosswalk-multiverse').click();
    await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(1);
    const refs = await page.evaluate(() => window.__multiVerseRequests[0].refs);
    expect(refs.map(ref => ref.url)).toEqual([
      'https://www.blueletterbible.org/kjv/rom/8/9/',
      'https://www.blueletterbible.org/kjv/jhn/3/16-18/',
      'https://www.blueletterbible.org/kjv/jde/1/3/',
      'https://www.blueletterbible.org/kjv/phm/1/6/',
      'https://www.blueletterbible.org/kjv/tit/2/11/'
    ]);
    expect(refs.map(ref => ref.text)).toEqual([
      'Romans 8:9', 'John 3:16-18', 'Jude 1:3', 'Philemon 1:6', 'Titus 2:11'
    ]);
  });

  test('Enduring Word MultiVerse ignores body references and unrelated cross-reference sections', async ({ page }) => {
    const sourceUrl = 'https://www.enduringword.com/bible-commentary/john-3/';
    await loadSourcePageMultiVerse(page, sourceUrl);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', `
        <article><a href="https://enduringword.com/bible-commentary/romans-8/">Romans 8</a>
          <a href="https://enduringword.com/bible-commentary/psalm-23/">Psalm 23</a></article>
        <aside class="ew-xref">
          <section class="ew-xref-sec">
            <h2 class="ew-xref-title">Related Articles</h2>
            <div class="ew-xref-chips"><a href="https://enduringword.com/bible-commentary/genesis-1/">Genesis 1</a></div>
          </section>
          <section class="ew-xref-sec">
            <h2 class="ew-xref-title">Referenced By</h2>
            <div class="ew-xref-chips">
              <a href="https://enduringword.com/bible-commentary/psalm-23/">Psalm 23</a>
              <a href="https://enduringword.com/bible-commentary/john-3/verse-16/">John 3:16</a>
              <a href="https://enduringword.com/bible-commentary/romans-8/">Romans 8</a>
            </div>
          </section>
        </aside>`);
    });
    await page.locator('#blb-suite-enduringword-multiverse').click();
    await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(1);
    const refs = await page.evaluate(() => window.__multiVerseRequests[0].refs);
    expect(refs.map(ref => ref.url)).toEqual([
      'https://www.blueletterbible.org/kjv/psa/23/1/',
      'https://www.blueletterbible.org/kjv/rom/8/1/'
    ]);
    expect(refs.every(ref => ref.text.endsWith(':1'))).toBe(true);
  });

  test('Christianity.com passage click guard ignores non-passage links and preserves modified clicks', async ({ page }) => {
    await loadProductionRedirect(page, 'https://www.christianity.com/faith/bible-study/article.html');
    await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => true);' });
    await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
    const results = await page.evaluate(() => {
      document.body.innerHTML = [
        '<a id="ordinary" href="/about/">About</a>',
        '<a id="foreign" href="https://www.esv.org/John+3%3A16/">John 3:16</a>',
        '<a id="bad-book" href="/bible/esv/not-a-book/3-16">John 3:16</a>',
        '<a id="modified" href="/bible/esv/john/3-16">John 3:16</a>'
      ].join('');
      const click = (id, options = {}) => {
        const anchor = document.getElementById(id);
        const event = new MouseEvent('click', { bubbles:true, cancelable:true, button:0, ...options });
        let guardPrevented = false;
        window.addEventListener('click', e => {
          guardPrevented = e.defaultPrevented;
          e.preventDefault();
        }, { once:true });
        anchor.dispatchEvent(event);
        return guardPrevented;
      };
      return {
        ordinary: click('ordinary'),
        foreign: click('foreign'),
        badBook: click('bad-book'),
        ctrl: click('modified', { ctrlKey:true }),
        shift: click('modified', { shiftKey:true }),
        middle: click('modified', { button:1 })
      };
    });
    expect(results).toEqual({
      ordinary:false, foreign:false, badBook:false, ctrl:false, shift:false, middle:false
    });
    expect(await page.evaluate(() => window.__openedBlbUrl || null)).toBeNull();
  });

  test('source-site passage click guards respect disabled redirect setting on all guarded hosts', async ({ page }) => {
    for (const source of [
      { url:'https://www.gotquestions.org/example-question.html', href:'/question-about-john-3-16', label:'John 3:16' },
      { url:'https://www.crosswalk.com/faith/bible-study/example.html', href:'/john-3-16', label:'John 3:16' },
      { url:'https://www.enduringword.com/bible-commentary/john-3/', href:'/john-3-16', label:'John 3:16' },
      { url:'https://www.churchofjesuschrist.org/study/scriptures/nt/matt/3?lang=eng', href:'/study/scriptures/nt/matt/3?id=p16&lang=eng', label:'Matt. 3:16' },
      { url:'https://mercyhouseministry.com/bible-study/article/', href:'/bible/?b=John&c=3&v=16', label:'John 3:16' }
    ]) {
      await loadProductionRedirect(page, source.url);
      await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => false);' });
      await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
      const result = await page.evaluate(({href,label}) => {
        document.body.innerHTML = '';
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.textContent = label;
        document.body.appendChild(anchor);
        let guardPrevented = null;
        window.addEventListener('click', event => {
          guardPrevented = event.defaultPrevented;
          event.preventDefault();
        }, { once:true });
        anchor.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, button:0 }));
        return guardPrevented;
      }, {href:source.href,label:source.label});
      expect(result, source.url).toBe(false);
      expect(await page.evaluate(() => window.__openedBlbUrl || null), source.url).toBeNull();
    }
  });

  test('ESV.org ignores malformed, unrelated, and invalid Bible references', async ({ page }) => {
    for (const sourceUrl of [
      'https://www.esv.org/',
      'https://www.esv.org/about/',
      'https://www.esv.org/resources/esv-crossreference-tool/',
      'https://www.esv.org/John+0/',
      'https://www.esv.org/John+999/',
      'https://www.esv.org/John+3%3A0/',
      'https://www.esv.org/John+3%3A999/',
      'https://www.esv.org/John+3%3A18-16/',
      'https://www.esv.org/NotABook+3%3A16/',
      'https://www.esv.org/verses/not-a-reference/'
    ]) {
      await loadProductionRedirect(page, sourceUrl);
      await page.addScriptTag({ content: productionRedirectGate });
      await page.waitForTimeout(30);
      expect(await page.evaluate(() => window.__openedBlbUrl || null), sourceUrl).toBeNull();
      expect(new URL(page.url()).hostname, sourceUrl).toBe('www.esv.org');
    }
  });


  test('non-Christianity source click guards ignore ordinary captions and non-primary clicks', async ({ page }) => {
    for (const source of [
      { url:'https://www.gotquestions.org/example-question.html' },
      { url:'https://www.crosswalk.com/faith/bible-study/example.html' },
      { url:'https://www.enduringword.com/bible-commentary/john-3/' }
    ]) {
      await loadProductionRedirect(page, source.url);
      await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => true);' });
      await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
      const result = await page.evaluate(() => {
        document.body.innerHTML = [
          '<a id="ordinary" href="/about/">Read more</a>',
          '<a id="external" href="https://www.esv.org/John+3%3A16/">Read more</a>',
          '<a id="modified" href="/passage">John 3:16</a>'
        ].join('');
        const check = (id, options = {}) => {
          const anchor = document.getElementById(id);
          const event = new MouseEvent('click', { bubbles:true, cancelable:true, button:0, ...options });
          let guardPrevented = false;
          window.addEventListener('click', e => {
            guardPrevented = e.defaultPrevented;
            e.preventDefault();
          }, { once:true });
          anchor.dispatchEvent(event);
          return guardPrevented;
        };
        return {
          ordinary:check('ordinary'),
          externalOrdinary:check('external'),
          ctrl:check('modified', { ctrlKey:true }),
          middle:check('modified', { button:1 })
        };
      });
      expect(result, source.url).toEqual({
        ordinary:false, externalOrdinary:false, ctrl:false, middle:false
      });
      expect(await page.evaluate(() => window.__openedBlbUrl || null), source.url).toBeNull();
    }
  });

  test('MultiVerse button can be dragged, restores its saved position, clamps to viewport, and resets without opening', async ({ page }) => {
    await loadSourcePageMultiVerse(page, 'https://www.christianity.com/wiki/bible/example.html');
    const button = page.locator('#blb-suite-christianity-multiverse');
    await page.waitForTimeout(50);
    const start = await button.boundingBox();
    expect(start).not.toBeNull();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(120, 130, {steps:6});
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__localStorageValues.blbSuiteMultiVerseButtonPosition || null)).not.toBeNull();
    const saved = await page.evaluate(() => window.__localStorageValues.blbSuiteMultiVerseButtonPosition);
    expect(saved.left).toBeGreaterThanOrEqual(0);
    expect(saved.top).toBeGreaterThanOrEqual(0);
    await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(0);

    await page.evaluate(async () => {
      document.getElementById('blb-suite-christianity-multiverse').remove();
      document.getElementById('blb-suite-christianity-multiverse-reset-position')?.remove();
      const replacement = document.createElement('button');
      replacement.id = 'blb-suite-christianity-multiverse';
      replacement.textContent = 'Open Bible References in BLB';
      replacement.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:9px 12px;font:600 13px Arial,sans-serif';
      document.body.appendChild(replacement);
      makeBlbMultiVerseButtonDraggable(replacement);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    const restored = await page.locator('#blb-suite-christianity-multiverse').boundingBox();
    expect(Math.abs(restored.x - saved.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(restored.y - saved.top)).toBeLessThanOrEqual(1);

    await page.setViewportSize({width:360,height:240});
    await page.waitForTimeout(30);
    const bounded = await page.locator('#blb-suite-christianity-multiverse').evaluate(el => {
      const r=el.getBoundingClientRect();
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};
    });
    expect(bounded.left).toBeGreaterThanOrEqual(0);
    expect(bounded.top).toBeGreaterThanOrEqual(0);
    expect(bounded.right).toBeLessThanOrEqual(bounded.width + 1);
    expect(bounded.bottom).toBeLessThanOrEqual(bounded.height + 1);

    await page.locator('#blb-suite-christianity-multiverse-reset-position').click();
    await expect.poll(() => page.evaluate(() => Object.hasOwn(window.__localStorageValues, 'blbSuiteMultiVerseButtonPosition'))).toBe(false);
    await expect(page.locator('#blb-suite-christianity-multiverse')).toHaveCSS('right', '18px');
    await expect(page.locator('#blb-suite-christianity-multiverse')).toHaveCSS('bottom', '18px');
    await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(0);
  });

  test('MultiVerse button remains keyboard activatable and reset control is accessible', async ({ page }) => {
    await loadSourcePageMultiVerse(page, 'https://www.gotquestions.org/example-question.html');
    const button = page.locator('#blb-suite-gotquestions-multiverse');
    await expect(button).toHaveAttribute('type', 'button');
    // Give the collection handler a real Bible link so Enter activation must
    // reach the same runtime hand-off path as a mouse click.
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'https://www.blueletterbible.org/kjv/jhn/3/16/';
      link.textContent = 'John 3:16';
      document.body.appendChild(link);
    });
    await page.evaluate(() => document.getElementById('blb-suite-gotquestions-multiverse').focus());
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__multiVerseRequests?.length || 0)).toBe(1);
    await expect(page.locator('#blb-suite-gotquestions-multiverse-reset-position')).toHaveAttribute('aria-label', 'Reset button position');
  });

});


// Exercise the actual King's Bible Concordance button and collector together.
// The HTML is deterministic and served under the real source origin, so the
// test verifies page integration without depending on the live site.
const kingsBibleModuleSource = read("extension/kings-bible-collector.js");
if (!kingsBibleModuleSource.includes("function collectKingsBibleReferences(") ||
    !kingsBibleModuleSource.includes("BLBKingsBibleCollector")) {
  throw new Error("Could not locate the extracted King's Bible collector module");
}
const kingsBibleMultiVerseCode =
  kingsBibleModuleSource +
  '\nBLBKingsBibleCollector.initialize({ BOOKS, normalizeSelectionText, parseRef, resolveBibleReference, blbUrl, isSuiteEnabled, makeBlbMultiVerseButtonDraggable: () => {} });';

async function loadKingsBibleMultiVerse(page, sourceUrl, pages) {
  const sourceOrigin = new URL(sourceUrl).origin;
  await page.route(sourceOrigin + "/**", route => {
    const url = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: pages[url.pathname] || "<!doctype html><html><head><title>Mock King's Bible</title></head><body></body></html>"
    });
  });
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ content: read("extension/regex-patterns.js") });
  await page.addScriptTag({ content: "const BLB_HOSTNAME = BLBShared.hostnames.blb;" });
  await page.addScriptTag({ content: read("extension/books.js") });
  await page.addScriptTag({ content: read("extension/book-aliases.js") });
  await page.addScriptTag({ content: read("extension/reference-core.js") });
  await page.addScriptTag({ content: productionRedirectHelpers });
  await page.addScriptTag({ content: 'function normalizeSelectionText(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }' });
  await page.addScriptTag({ content: 'window.__localStorageValues = {}; window.__multiVerseRequests = []; window.isSuiteEnabled = async () => true; window.chrome = { storage: { local: { get: async defaults => Object.assign({}, defaults || {}, window.__localStorageValues), set: async values => Object.assign(window.__localStorageValues, values), remove: async key => { for (const k of (Array.isArray(key) ? key : [key])) delete window.__localStorageValues[k]; } }, onChanged: { addListener: () => {} } }, runtime: { sendMessage: async message => { window.__multiVerseRequests.push(message); return { ok: true }; } } };' });
  await page.addScriptTag({ content: kingsBibleMultiVerseCode });
  await page.waitForSelector("#blb-suite-kingsbible-multiverse");
}

test("The King's Bible Concordance button collects and deduplicates references across numbered pages", async ({ page }) => {
  const sourceUrl = "https://www.thekingsbible.com/Concordance/faith/1";
  const pagination = '<ul class="pagination"><li class="current-page"><a href="#">1</a></li><li class="current-page"><a href="#">2</a></li><li class="current-page"><a href="#">3</a></li></ul>';
  const pages = {
    "/Concordance/faith/1": '<!doctype html><html><body>' + pagination +
      '<div id="ConcordanceTable"><a class="concordanceitem" href="/Bible/1/1?verse=1">Genesis 1:1</a></div></body></html>',
    "/Concordance/faith/2": '<!doctype html><html><body><div id="ConcordanceTable">' +
      '<a class="concordanceitem" href="/Bible/1/1?verse=1">Genesis 1:1 duplicate</a>' +
      '<a class="concordanceitem" href="/Bible/2/4?verse=14">Exodus 4:14</a>' +
      '</div></body></html>',
    "/Concordance/faith/3": '<!doctype html><html><body><div id="ConcordanceTable">' +
      '<a class="concordanceitem" href="/Bible/7/6?verse=15">Judges 6:15</a>' +
      '</div></body></html>'
  };

  await loadKingsBibleMultiVerse(page, sourceUrl, pages);
  await page.locator("#blb-suite-kingsbible-multiverse").click();
  await expect.poll(() => page.evaluate(() => window.__multiVerseRequests.length), { timeout: 5000 }).toBe(1);

  const request = await page.evaluate(() => window.__multiVerseRequests[0]);
  expect(request.type).toBe("blbSuiteOpenWebsterMultiVerse");
  expect(request.refs.map(ref => ref.text.toLowerCase())).toEqual(["genesis 1:1", "exodus 4:14", "judges 6:15"]);
  expect(request.refs.map(ref => ref.url)).toEqual([
    "https://www.blueletterbible.org/kjv/gen/1/1/",
    "https://www.blueletterbible.org/kjv/exo/4/14/",
    "https://www.blueletterbible.org/kjv/jdg/6/15/"
  ]);
});

test('ChurchofJesusChrist and Mercy House individual verse clicks open the exact BLB KJV verse', async ({ page }) => {
  const cases = [
    {
      pageUrl: 'https://www.churchofjesuschrist.org/study/scriptures/bible-reference/1?lang=eng',
      href: 'https://www.churchofjesuschrist.org/study/scriptures/nt/matt/3?id=p16-p17&lang=eng',
      label: 'Matt. 3:16-17',
      expected: 'https://www.blueletterbible.org/kjv/mat/3/16-17/'
    },
    {
      pageUrl: 'https://mercyhouseministry.com/bible-study/his-mercies-are-new-every-morning/',
      href: 'https://mercyhouseministry.com/bible/?b=Lamentations&c=3&v=22-23',
      label: 'Lamentations 3:22-23',
      expected: 'https://www.blueletterbible.org/kjv/lam/3/22-23/'
    }
  ];

  for (const source of cases) {
    await loadProductionRedirect(page, source.pageUrl);
    await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => true);' });
    await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
    const result = await page.evaluate(({href,label}) => {
      document.body.innerHTML = '';
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.textContent = label;
      document.body.appendChild(anchor);
      const click = new MouseEvent('click', { bubbles:true, cancelable:true, button:0 });
      const dispatchAllowed = anchor.dispatchEvent(click);
      return { prevented: !dispatchAllowed || click.defaultPrevented, target: window.__openedBlbUrl || null };
    }, source);
    expect(result.prevented, source.pageUrl).toBe(true);
    expect(result.target, source.pageUrl).toBe(source.expected);
  }
});

test('direct ChurchofJesusChrist and Mercy House verse URLs resolve to exact BLB KJV passages', async ({ page }) => {
  const cases = [
    {
      url: 'https://www.churchofjesuschrist.org/study/scriptures/nt/matt/3?id=p16-p17&lang=eng',
      expected: 'https://www.blueletterbible.org/kjv/mat/3/16-17/'
    },
    {
      url: 'https://mercyhouseministry.com/bible/?b=Lamentations&c=3&v=22-23',
      expected: 'https://www.blueletterbible.org/kjv/lam/3/22-23/'
    }
  ];
  for (const source of cases) {
    await loadProductionRedirect(page, source.url);
    await page.evaluate(() => redirectBibleSite());
    expect(await page.evaluate(() => window.__redirectedTo || null), source.url).toBe(source.expected);
  }
});

test('OpenBible, Crossway and Sarata individual verse links open the exact BLB KJV passage', async ({ page }) => {
  const cases = [
    {
      pageUrl: 'https://www.openbible.info/topics/scripture',
      href: 'https://www.biblegateway.com/passage/?search=2%20Timothy%203%3A16',
      label: '2 Timothy 3:16',
      expected: 'https://www.blueletterbible.org/kjv/2ti/3/16/'
    },
    {
      pageUrl: 'https://www.crossway.org/articles/fixture/',
      href: 'https://www.esv.org/Romans+8%3A1-2/',
      label: 'Romans 8:1-2',
      expected: 'https://www.blueletterbible.org/kjv/rom/8/1-2/'
    },
    {
      pageUrl: 'https://sarata.com/bible/chapter/Psalms.23.html',
      href: 'https://sarata.com/bible/verses/Exodus.3.html#3:2',
      label: 'The LORD appeared unto Moses',
      expected: 'https://www.blueletterbible.org/kjv/exo/3/2/'
    }
  ];

  for (const source of cases) {
    await loadProductionRedirect(page, source.pageUrl);
    await page.addScriptTag({ content: 'installChristianityLinkRedirect(() => true);' });
    await page.addScriptTag({ content: read('extension/redirect-christianity-main-world.js') });
    const result = await page.evaluate(({href,label}) => {
      document.body.innerHTML = '';
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.textContent = label;
      document.body.appendChild(anchor);
      const click = new MouseEvent('click', { bubbles:true, cancelable:true, button:0 });
      const dispatchAllowed = anchor.dispatchEvent(click);
      return { prevented: !dispatchAllowed || click.defaultPrevented, target: window.__openedBlbUrl || null };
    }, source);
    expect(result.prevented, source.pageUrl).toBe(true);
    expect(result.target, source.pageUrl).toBe(source.expected);
  }
});

test('direct Sarata chapter fragment URLs resolve to the exact BLB KJV verse', async ({ page }) => {
  await loadProductionRedirect(page, 'https://sarata.com/bible/chapter/Psalms.23.html#23:1');
  await page.evaluate(() => redirectBibleSite());
  expect(await page.evaluate(() => window.__redirectedTo || null))
    .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
});



const source = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
const sourceRedirectModule = fs.readFileSync(path.resolve(__dirname, '../../extension/source-bible-redirect.js'), 'utf8');
const booksSource = fs.readFileSync(path.resolve(__dirname, '../../extension/books.js'), 'utf8');
const aliasesSource = fs.readFileSync(path.resolve(__dirname, '../../extension/book-aliases.js'), 'utf8');
const referenceCoreSource = fs.readFileSync(path.resolve(__dirname, '../../extension/reference-core.js'), 'utf8');
const sharedPatternsSource = fs.readFileSync(path.resolve(__dirname, '../../extension/regex-patterns.js'), 'utf8');
const decodeStart = source.indexOf('function decodeSafe(v) {');
const bookKeyStart = source.indexOf('function bookKey(value) {');
const parseStart = source.indexOf('function parseRef(text) {', decodeStart);
const blbUrlStart = source.indexOf('function blbUrl(', decodeStart);
const redirectStart = source.indexOf('const redirectBibleSite = globalThis.BLBSourceBibleRedirectModule.initialize({', parseStart);
if ([decodeStart, bookKeyStart, blbUrlStart, parseStart, redirectStart].some(index => index < 0)) {
  throw new Error('Could not locate source-site redirect helpers in extension/content.js');
}
// Exercise the production book table, alias resolver, reference validator, and URL builder.
const helpers = sharedPatternsSource + '\n' + booksSource + '\n' + aliasesSource + '\n' + referenceCoreSource + '\n' +
  source.slice(bookKeyStart, redirectStart) + sourceRedirectModule +
  '\nconst redirectBibleSite = BLBSourceBibleRedirectModule.initialize({ BLBShared, BOOKS, bookKey, parseChristianityBibleLink, validateSourceBibleReference, parseRef, decodeSafe, blbUrl, openBlbDestinationFromContent });';

function runSourceRedirect(url) {
  let redirectedTo = null;
  let openedInNewTab = null;
  const context = {
    URL,
    location: {
      href: url,
      replace(target) { redirectedTo = target; }
    },
    openBlbDestinationFromContent(target) { openedInNewTab = target; },
    // No blbUrl stub: this calls the real production resolver.

  };
  vm.runInNewContext(helpers + '\nresult = redirectBibleSite();', context);
  return { result: context.result, redirectedTo, openedInNewTab };
}

test.describe('source Bible URL syntax regression coverage', () => {
  test('Bible Hub general and translation-prefixed verse URLs', () => {
    expect(runSourceRedirect('https://biblehub.com/john/3-16.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://biblehub.com/kjv/john/3-16.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://biblehub.com/esv/john/3-16.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('Bible Hub alternate passage URL preserves a verse range', () => {
    expect(runSourceRedirect('https://biblehub.com/passage/john/3/16-18').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
  });

  test('BibleRef commentary path extracts the verse from the repeated chapter slug', () => {
    expect(runSourceRedirect('https://www.bibleref.com/john/3/john-3-16.html').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://www.bibleref.com/john/3/john-3-16-17.html').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-17/');
  });

  test('BibleRef search URL parses underscore-separated references and ranges', () => {
    expect(runSourceRedirect('https://www.bibleref.com/biblepassage/?search=John_3%3A16-17').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-17/');
  });

  test('Official King James Bible preserves a verse range', () => {
    expect(runSourceRedirect('https://officialkingjamesbible.com/bible/1-john/3/16-17').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/3/16-17/');
  });

  test("The King's Bible direct chapter and selected-verse URLs redirect to BLB KJV", () => {
    expect(runSourceRedirect('https://www.thekingsbible.com/Bible/43/3').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
    expect(runSourceRedirect('https://www.thekingsbible.com/Bible/43/3?verse=16').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('King James Bible Online preserves underscore-separated same-chapter ranges', () => {
    expect(runSourceRedirect('https://kingjamesbibleonline.org/John-3-16_3-17/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-17/');
  });

  test('Christianity.com homepage is excluded; chapter, verse, and range routes open BLB in a new tab', () => {
    for (const url of [
      'https://www.christianity.com/',
      'https://www.christianity.com/bible/',
      'https://www.christianity.com/bible/help/passage-search-basics/'
    ]) {
      expect(runSourceRedirect(url).openedInNewTab, url).toBeNull();
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
    }
    expect(runSourceRedirect('https://www.christianity.com/bible/esv/ephesians/2').openedInNewTab)
      .toBe('https://www.blueletterbible.org/kjv/eph/2/1/');
    expect(runSourceRedirect('https://www.christianity.com/bible/esv/john/3-16').openedInNewTab)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://www.christianity.com/bible/niv%2Cesv/1-john/3-16-21').openedInNewTab)
      .toBe('https://www.blueletterbible.org/kjv/1jo/3/16-21/');
    expect(runSourceRedirect('https://christianity.com/bible/esv/2-corinthians/5-17').openedInNewTab)
      .toBe('https://www.blueletterbible.org/kjv/2co/5/17/');
    for (const url of [
      'https://www.christianity.com/bible/esv/ephesians/2',
      'https://www.christianity.com/bible/esv/john/3-16',
      'https://www.christianity.com/bible/niv%2Cesv/1-john/3-16-21'
    ]) {
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
    }
    for (const url of [
      'https://www.christianity.com/bible/esv/john/0',
        'https://www.christianity.com/bible/esv/john/3-18-16',
      'https://www.christianity.com/bible/esv/not-a-book/3-16',
      'https://www.christianity.com/bible/esv/john/999-1'
    ]) {
      expect(runSourceRedirect(url).openedInNewTab, url).toBeNull();
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
    }
  });

  test('ESV.org supports root-level chapters, verses, ranges, and /verses/ references', () => {
    expect(runSourceRedirect('https://www.esv.org/Ephesians+2/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/eph/2/1/');
    expect(runSourceRedirect('https://www.esv.org/Ephesians%2B2/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/eph/2/1/');
    expect(runSourceRedirect('https://esv.org/John+3%3A16/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://www.esv.org/John+3%3A16-18/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
    expect(runSourceRedirect('https://www.esv.org/verses/John%2B3%3A16/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://esv.org/verses/John%2B3%3A16-18/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
    expect(runSourceRedirect('https://www.esv.org/verses/Psalm%2B23/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
    for (const url of [
      'https://www.esv.org/',
      'https://www.esv.org/about/',
      'https://www.esv.org/resources/esv-crossreference-tool/'
    ]) {
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
      expect(runSourceRedirect(url).openedInNewTab, url).toBeNull();
    }
  });

  test('translation selection does not alter the BLB KJV destination', () => {
    expect(runSourceRedirect('https://www.bible.com/bible/111/JHN.3.16-21.niv').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-21/');
    expect(runSourceRedirect('https://www.bibleportal.com/verse-topic?v=john+3%3A16&version=NIV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('Bible.com single verse, chapter, and range formats always target KJV', () => {
    expect(runSourceRedirect('https://www.bible.com/bible/111/GEN.1.1.niv').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/gen/1/1/');
    expect(runSourceRedirect('https://www.bible.com/bible/1/PSA.23.niv').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
    expect(runSourceRedirect('https://www.bible.com/bible/111/1JN.4.7-8.esv').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/4/7-8/');
  });

  test('BibleGateway passage search supports single verses, ranges, and ignored versions', () => {
    expect(runSourceRedirect('https://www.biblegateway.com/passage/?search=Romans%208%3A28&version=NIV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/rom/8/28/');
    expect(runSourceRedirect('https://biblegateway.com/passage/?version=ESV&search=1%20John%204%3A7-8').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/4/7-8/');
    expect(runSourceRedirect('https://biblegateway.com/passage/?search=Psalm%2023&version=KJV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
  });

  test('Bible Hub supports single verses, chapters, and ranges in standard and translation paths', () => {
    expect(runSourceRedirect('https://biblehub.com/genesis/1.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/gen/1/1/');
    expect(runSourceRedirect('https://biblehub.com/john/3-16-18.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
    expect(runSourceRedirect('https://biblehub.com/niv/1_john/4-7-8.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/4/7-8/');
  });

  test('King James Bible Online supports chapter routes, compact chapter routes, and repeated leading slashes', () => {
    expect(runSourceRedirect('https://kingjamesbibleonline.org/John-Chapter-3/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/John-Chapter-1_Original-1611-KJV/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/1/1/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/' + '/John-Chapter-3/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/Psalms-23/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
  });

  test('King James Bible Online preserves verse ranges and numbered book names', () => {
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/John-3-16-18/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/1-John-4-7-8/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/4/7-8/');
  });

  test('KJBO alias hostname is checked separately from the main domain', () => {
    expect(runSourceRedirect('https://kjbo.org/John-3-16/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('KJV.site supports chapter and verse routes independently of www', () => {
    expect(runSourceRedirect('https://kjv.site/John-3-kjv/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
    expect(runSourceRedirect('https://www.kjv.site/John-3-16-kjv/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('BiblePortal supports its alternate reference parameter and version ordering', () => {
    expect(runSourceRedirect('https://bibleportal.com/verse-topic?verse-topic=Matthew.5.3-5&version=ESV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/mat/5/3-5/');
    expect(runSourceRedirect('https://www.bibleportal.com/verse-topic?v=Psalm%2023&version=NKJV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
  });

  test("The King's Bible maps home, Strong's entries, dictionary/concordance, and passages", () => {
    expect(runSourceRedirect('https://www.thekingsbible.com/').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary#').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Concordance').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Concordance#').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/StrongsNo/H3811').redirectedTo).toBe('https://www.blueletterbible.org/lexicon/h3811/kjv/wlc/0-1/');
    expect(runSourceRedirect('https://www.thekingsbible.com/Bible/18/4?verse=5').redirectedTo).toBe('https://www.blueletterbible.org/kjv/job/4/5/');
    expect(runSourceRedirect('https://www.thekingsbible.com/Bible/3/1').redirectedTo).toBe('https://www.blueletterbible.org/kjv/lev/1/1/');
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary/Habakkuk').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary/Habitation').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary/').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Concordance/beautify').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Concordance/').redirectedTo).toBeNull();
  });

  test('unsupported and malformed source URLs do not redirect', () => {
    expect(runSourceRedirect('https://biblehub.com/not-a-book/abc.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://biblehub.com/john/3-16-18-20.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://example.com/john/3-16.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://biblegateway.com/search/?search=John%203%3A16').redirectedTo).toBe(null);
  });


  test('new source redirects require an exact supported hostname, not a lookalike domain or subdomain', () => {
    for (const url of [
      'https://notchristianity.com/bible/esv/john/3-16',
      'https://christianity.com.example.test/bible/esv/john/3-16',
      'https://blog.christianity.com/bible/esv/john/3-16',
      'https://not-esv.org/John+3%3A16/',
      'https://esv.org.example.test/John+3%3A16/',
      'https://blog.esv.org/John+3%3A16/'
    ]) {
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
      expect(runSourceRedirect(url).openedInNewTab, url).toBeNull();
    }
  });

});


test('table-driven source redirect matrix preserves validated destinations across supported URL families', () => {
  const cases = [
    ['Bible.com translation-prefixed range', 'https://www.bible.com/bible/111/1JN.4.7-8.esv', 'https://www.blueletterbible.org/kjv/1jo/4/7-8/'],
    ['BibleGateway search with ignored translation', 'https://www.biblegateway.com/passage/?search=Romans%208%3A28&version=NIV', 'https://www.blueletterbible.org/kjv/rom/8/28/'],
    ['BibleRef commentary range', 'https://www.bibleref.com/john/3/john-3-16-17.html', 'https://www.blueletterbible.org/kjv/jhn/3/16-17/'],
    ['Bible Hub alternate passage range', 'https://biblehub.com/passage/john/3/16-18', 'https://www.blueletterbible.org/kjv/jhn/3/16-18/'],
    ['Christianity.com passage opens a new tab', 'https://www.christianity.com/bible/esv/john/3-16', 'https://www.blueletterbible.org/kjv/jhn/3/16/', 'newTab'],
    ['ESV encoded plus-sign range', 'https://www.esv.org/verses/John%2B3%3A16-18/', 'https://www.blueletterbible.org/kjv/jhn/3/16-18/'],
    ['BiblePortal dotted book and range', 'https://bibleportal.com/verse-topic?verse-topic=Matthew.5.3-5&version=ESV', 'https://www.blueletterbible.org/kjv/mat/5/3-5/'],
    ['King James Bible Online underscore range', 'https://kingjamesbibleonline.org/John-3-16_3-17/', 'https://www.blueletterbible.org/kjv/jhn/3/16-17/'],
    ['King James Bible Online chapter route', 'https://www.kingjamesbibleonline.org/John-Chapter-3/', 'https://www.blueletterbible.org/kjv/jhn/3/1/'],
    ['KJV.site verse route', 'https://kjv.site/John-3-16-kjv/', 'https://www.blueletterbible.org/kjv/jhn/3/16/'],
    ['KJV.site mobile subdomain verse route', 'https://m.kjv.site/John-3-16-kjv/', 'https://www.blueletterbible.org/kjv/jhn/3/16/'],
    ['Official King James Bible numbered book range', 'https://officialkingjamesbible.com/bible/1-john/3/16-17', 'https://www.blueletterbible.org/kjv/1jo/3/16-17/'],
    ["The King's Bible numeric book and query verse", 'https://www.thekingsbible.com/Bible/18/4?verse=5', 'https://www.blueletterbible.org/kjv/job/4/5/'],
    ["The King's Bible Strong's entry", 'https://www.thekingsbible.com/StrongsNo/H3811', 'https://www.blueletterbible.org/lexicon/h3811/kjv/wlc/0-1/']
  ];

  for (const [label, url, expected, mode] of cases) {
    const result = runSourceRedirect(url);
    const actual = mode === 'newTab' ? result.openedInNewTab : result.redirectedTo;
    expect(actual, label + ': ' + url).toBe(expected);
    if (mode === 'newTab') expect(result.redirectedTo, label).toBeNull();
  }
});

test('single verse boundaries normalize consistently across source hosts', () => {
  const cases = [
    ['Bible Hub verse zero', 'https://biblehub.com/john/3-0.htm', 'https://www.blueletterbible.org/kjv/jhn/3/1/'],
    ['Bible Hub verse above chapter maximum', 'https://biblehub.com/john/3-999.htm', 'https://www.blueletterbible.org/kjv/jhn/3/36/'],
    ['KJV.site mobile verse zero', 'https://m.kjv.site/John-3-0-kjv/', 'https://www.blueletterbible.org/kjv/jhn/3/1/']
  ];
  for (const [label, url, expected] of cases) {
    expect(runSourceRedirect(url).redirectedTo, label).toBe(expected);
  }
});

test('table-driven malformed reference matrix refuses unsafe or ambiguous destinations', () => {
  const cases = [
    'https://biblehub.com/not-a-book/abc.htm',
    'https://biblehub.com/john/3-16-18-20.htm',
    'https://biblegateway.com/search/?search=John%203%3A16',
    'https://www.christianity.com/bible/esv/john/3-18-16',
    'https://kjv.site/not-a-book-3-16-kjv/',
    'https://m.kjv.site/John-3-16-18-20-kjv/',
    'https://notchristianity.com/bible/esv/john/3-16',
    'https://christianity.com.example.test/bible/esv/john/3-16',
    'https://blog.esv.org/John+3%3A16/'
  ];

  for (const url of cases) {
    const result = runSourceRedirect(url);
    expect(result.redirectedTo, url).toBeNull();
    expect(result.openedInNewTab, url).toBeNull();
  }
});




