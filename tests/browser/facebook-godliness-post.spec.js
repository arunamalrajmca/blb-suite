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
