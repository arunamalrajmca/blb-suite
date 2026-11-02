const { test, expect } = require('./fixtures');

test('Facebook Godliness post: extract references from the supplied paragraph DOM', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'facebook.com': true, 'www.facebook.com': true } });
  await page.route('https://www.facebook.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>Facebook Godliness post fixture</title></head><body></body></html>'
  }));
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  await page.evaluate(() => {
    const article = document.createElement('div');
    article.id = 'fb-godliness-post';
    article.className = 'html-div xdj266r x14z9mp xat24cr x1lziwak xexx8yu xyri2b x18d9i69 x1c1uobl';
    article.innerHTML = `
      <div class="xdj266r x14z9mp xat24cr x1lziwak x1vvkbs x126k92a">
        <div dir="auto" style="text-align:start">What is the mystery of Godliness?</div>
        <div dir="auto" style="text-align:start">The Mystery of Godliness is not that Christ would take on Himself mankind’s flesh and dwell among His people because that was prophesied (Isa. 9:6, 7; John 1:14; Matt. 1:18-23; Luke 1:30-35).</div>
      </div>
      <div class="x14z9mp xat24cr x1lziwak x1vvkbs xtlvy1s x126k92a">
        <div dir="auto" style="text-align:start">The Mystery of Godliness is that Christ is manifesting Himself to the world through the believer.</div>
        <div dir="auto" style="text-align:start">1 Timothy 3:16 And without controversy great is the mystery of godliness: God was manifest in the flesh [the mystery of godliness is that Christ is manifesting Himself through the believers Gal. 2:20, 4:6; Rom. 5:5, 8:9; 1 Cor. 6:19; 2 Cor. 1:22, 4:7, 10, 11; Eph. 3:16, 17; Phil. 2:13; Col. 1:27; 2 Tim. 1:7] justified in the Spirit [we are declared justified when His Spirit is in us Rom. 3:26], seen of angels [the angels are watching us 1 Cor. 4:9, 1 Cor. 11:10; Eph. 3:10], preached unto the Gentiles [Paul preached Jesus Christ according to the revelation of the mystery Rom. 16:25-27; Acts 13:42, 18:6, 28:28; Rom. 11:11-13; Col. 1:23], believed on in the world [Eph. 1:7, 13, 14, 2:8, 9; Col. 1:6], received up into glory [1 Thess. 4:15-17; 1 Cor. 15:51-53].</div>
      </div>
      <div class="x14z9mp xat24cr x1lziwak x1vvkbs xtlvy1s x126k92a">
        <div dir="auto" style="text-align:start">In fact, the entire Godhead (Col. 2:9) is manifested in the believer today, during this dispensation of grace.</div>
        <div dir="auto" style="text-align:start">The Father</div>
        <div dir="auto" style="text-align:start">“One God and Father of all, who is above all, and through all, and in you all” (Eph. 4:6).</div>
        <div dir="auto" style="text-align:start">Son of God</div>
        <div dir="auto" style="text-align:start">“And because ye are sons, God hath sent forth the Spirit of his Son into your hearts, crying, Abba, Father” (Gal. 4:6).</div>
        <div dir="auto" style="text-align:start">“That he would grant you, according to the riches of his glory, to be strengthened with might by his Spirit in the inner man; That Christ may dwell in your hearts by faith; that ye, being rooted and grounded in love” (Eph. 3:16, 17).</div>
        <div dir="auto" style="text-align:start">Holy Ghost</div>
        <div dir="auto" style="text-align:start">“That good thing which was committed unto thee keep by the Holy Ghost which dwelleth in us” (2 Tim. 1:14).</div>
      </div>
      <div class="x14z9mp xat24cr x1lziwak x1vvkbs xtlvy1s x126k92a">
        <div dir="auto" style="text-align:start">We are in Christ, and He is in us.</div>
      </div>
      <div class="x14z9mp xat24cr x1lziwak x1vvkbs xtlvy1s x126k92a">
        <div dir="auto" style="text-align:start">Apostle Paul, our pattern (1 Tim. 1:15, 16), said, “And they glorified God in me” (Gal. 1:24).</div>
      </div>`;
    document.body.appendChild(article);
  });

  const structure = await page.locator('#fb-godliness-post > div[dir], #fb-godliness-post > div > div[dir]').count();
  expect(structure).toBeGreaterThan(10);
  const selectedText = await page.locator('#fb-godliness-post').innerText();
  const extracted = await extensionWorker.evaluate(text =>
    extractBibleRefsFromSelectedTextUncached(text).map(ref => ({
      book: ref.book, chapter: ref.chapter,
      from: ref.from ?? null, to: ref.to ?? null
    })), selectedText
  );

  process.stdout.write('[FACEBOOK GODLINESS POST REFERENCES] ' + JSON.stringify({
    paragraphCount: structure,
    extractedCount: extracted.length,
    references: extracted
  }) + '\\n');

  expect(extracted.length).toBeGreaterThanOrEqual(30);
  expect(extracted.some(ref => ref.book === 'isaiah' && ref.chapter === 9 && ref.from === 6 && ref.to === 7)).toBe(true);
  expect(extracted.some(ref => ref.book === '2 corinthians' && ref.chapter === 4 && ref.from === 10 && ref.to === 10)).toBe(true);
  expect(extracted.some(ref => ref.book === 'acts' && ref.chapter === 28 && ref.from === 28 && ref.to === 28)).toBe(true);
  expect(extracted.some(ref => ref.book === 'ephesians' && ref.chapter === 2 && ref.from === 8 && ref.to === 9) || (extracted.some(ref => ref.book === 'ephesians' && ref.chapter === 2 && ref.from === 8) && extracted.some(ref => ref.book === 'ephesians' && ref.chapter === 2 && ref.from === 9))).toBe(true);
  expect(extracted.some(ref => ref.book === '1 timothy' && ref.chapter === 1 && ref.from === 15 && ref.to === 16)).toBe(true);
});

test('Facebook shorthand references retain their explicitly named book', async ({ extensionWorker }) => {
  const cases = [
    { text: 'Gal. 2:20, 4:6', expected: [['galatians', 2, 20], ['galatians', 4, 6]] },
    { text: 'Eph. 1:7, 13, 14, 2:8, 9', expected: [['ephesians', 1, 7], ['ephesians', 1, 13], ['ephesians', 1, 14], ['ephesians', 2, 8], ['ephesians', 2, 9]] },
    { text: '2 Cor. 1:22, 4:7, 10, 11', expected: [['2 corinthians', 1, 22], ['2 corinthians', 4, 7], ['2 corinthians', 4, 10], ['2 corinthians', 4, 11]] },
    { text: 'Acts 13:42, 18:6, 28:28', expected: [['acts', 13, 42], ['acts', 18, 6], ['acts', 28, 28]] }
  ];
  const results = await extensionWorker.evaluate(items => items.map(item => ({
    text: item.text,
    refs: extractBibleRefsFromSelectedTextUncached(item.text).map(ref => [ref.book, ref.chapter, ref.from])
  })), cases);
  for (let i = 0; i < cases.length; i++) {
    expect(results[i].refs, cases[i].text).toEqual(cases[i].expected);
  }
});

test('Facebook Godliness shorthand citations open the clicked chapter and verse', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'facebook.com': true, 'www.facebook.com': true } });
  await page.route('https://www.facebook.com/**', route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: '<!doctype html><html><head><title>Facebook shorthand click fixture</title></head><body></body></html>'
  }));
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const article = document.createElement('div');
    article.setAttribute('role', 'article');
    article.innerHTML = `
      <div data-ad-comet-preview="message"><div dir="auto">The Mystery of Godliness is that Christ is manifesting Himself through the believers
        <span id="gal-book">Gal.</span> <span id="gal-c1">2</span>:<span id="gal-v1">20</span>,
        <span id="gal-c2">4</span>:<span id="gal-v2">6</span>;
        <span id="eph-book">Eph.</span> <span id="eph-c1">1</span>:<span id="eph-v1">7</span>, 13, 14,
        <span id="eph-c2">2</span>:<span id="eph-v2">8</span>, <span id="eph-v3">9</span>;
        <span id="cor-book">2 Cor.</span> <span id="cor-c1">1</span>:<span id="cor-v1">22</span>,
        <span id="cor-c2">4</span>:<span id="cor-v2">7</span>, 10, 11;
        <span id="acts-book">Acts</span> <span id="acts-c1">13</span>:<span id="acts-v1">42</span>,
        <span id="acts-c2">18</span>:<span id="acts-v2">6</span>,
        <span id="acts-c3">28</span>:<span id="acts-v3">28</span>
      </div></div>`;
    article.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(article);
  });

  const cases = [
    ['#gal-c2', '/kjv/gal/4/6/'],
    ['#eph-c2', '/kjv/eph/2/8/'],
    ['#eph-v3', '/kjv/eph/2/9/'],
    ['#cor-c2', '/kjv/2co/4/7/'],
    ['#acts-c3', '/kjv/act/28/28/']
  ];
  for (const [selector, expectedPath] of cases) {
    const baseline = await extensionWorker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id));
    await page.locator(selector).dblclick();
    let observed = null;
    await expect.poll(async () => {
      const tabs = await extensionWorker.evaluate(async ids => (await chrome.tabs.query({}))
        .filter(tab => !ids.includes(tab.id))
        .map(tab => tab.pendingUrl || tab.url || ''), baseline);
      observed = tabs.map(value => { try { return new URL(value).pathname; } catch (_) { return ''; } })
        .find(pathname => pathname === expectedPath) || null;
      return observed;
    }, { timeout: 10000 }).toBe(expectedPath);
    const opened = await extensionWorker.evaluate(async ids => (await chrome.tabs.query({}))
      .filter(tab => !ids.includes(tab.id)).map(tab => tab.id), baseline);
    for (const id of opened) await extensionWorker.evaluate(tabId => chrome.tabs.remove(tabId).catch(() => {}), id);
  }
});
