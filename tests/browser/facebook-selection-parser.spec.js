const { test, expect } = require('./fixtures');

test('Bible-reference selection normalization applies NFKC and shared Unicode cleanup', async ({ extensionWorker }) => {
  const cases = [
    ['𝐑𝐨𝐦𝐚𝐧𝐬 𝟏𝟎:𝟗–𝟏𝟐', 'Romans 10:9-12'],
    ['Ｒｏｍａｎｓ　１０：９－１２', 'Romans 10:9-12'],
    ['Romans\u00A010:9\u201112', 'Romans 10:9-12'],
    ['1\u200F Corinthians ４:１７', '1 Corinthians 4:17']
  ];
  const result = await extensionWorker.evaluate(cases =>
    cases.map(([input]) => normalizeSelectedScriptureText(input)), cases
  );
  expect(result).toEqual(cases.map(([, expected]) => expected));
});

test('NFKC-normalized references resolve compatibility-form ranges for all 66 books', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const fullWidth = value => Array.from(String(value), character => {
      const code = character.charCodeAt(0);
      if ((code >= 0x21 && code <= 0x7E)) return String.fromCharCode(code + 0xFEE0);
      if (character === ' ') return '\u3000';
      return character;
    }).join('');
    return BOOKS.map(book => {
      const source = fullWidth(book.name + ' 1:1-2');
      const normalized = normalizeSelectedScriptureText(source);
      const ref = resolveBibleReferenceText(normalized)[0];
      return !!ref && ref.book === book.name && ref.chapter === 1 &&
        ref.from === 1 && ref.to === 2;
    });
  });
  expect(result).toHaveLength(66);
  expect(result.every(Boolean)).toBe(true);
});

test('Facebook selection parser preserves numbered-book references across invisible Unicode marks', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = [
      'Acts 16:1-3',
      'Romans 16:21',
      '1\u200f Corinthians 4:17',
      'Philippians 2:19-22',
      'Colossians 1:1'
    ].join('\n');
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from,
      to: ref.to
    }));
  });

  expect(result).toEqual([
    { book: 'acts', chapter: 16, from: 1, to: 3 },
    { book: 'romans', chapter: 16, from: 21, to: 21 },
    { book: '1 corinthians', chapter: 4, from: 17, to: 17 },
    { book: 'philippians', chapter: 2, from: 19, to: 22 },
    { book: 'colossians', chapter: 1, from: 1, to: 1 }
  ]);
});

test('Facebook selection parser retains every reference in a clean multi-book selection', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = [
      'Romans 16:21',
      '1 Corinthians 4:17',
      'Philippians 2:19-22'
    ].join('\n');
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from,
      to: ref.to
    }));
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 16, from: 21, to: 21 },
    { book: '1 corinthians', chapter: 4, from: 17, to: 17 },
    { book: 'philippians', chapter: 2, from: 19, to: 22 }
  ]);
});

test('Facebook selection parser preserves numbered books after normalization collapses verse-ending whitespace', async ({ extensionWorker }) => {
  const cases = [
    ['Romans 16:21', '1 Corinthians 4:17', 'Philippians 2:19-22'],
    ['Romans 16:22', '2 Corinthians 13:14', 'Galatians 6:18'],
    ['Romans 16:23', '3 John 1:4', 'Jude 1:5']
  ];
  const results = await extensionWorker.evaluate(cases => cases.map(lines => {
    const normalized = normalizeSelectedScriptureText(lines.join('\n'));
    return extractBibleRefsFromSelectedTextUncached(normalized).map(ref => ref.book);
  }), cases);

  expect(results[0]).toEqual(['romans', '1 corinthians', 'philippians']);
  expect(results[1]).toEqual(['romans', '2 corinthians', 'galatians']);
  expect(results[2]).toEqual(['romans', '3 john', 'jude']);
});

test('Facebook selection parser preserves references across the reported reordered selection combinations', async ({ extensionWorker }) => {
  const cases = [
    ['Romans 16:21', '1 Corinthians 4:17', 'Philippians 2:19-22'],
    ['1 Corinthians 4:17', 'Philippians 2:19-22'],
    ['Philippians 2:19-22', 'Colossians 1:1', 'Romans 16:21', '1 Corinthians 4:17'],
    ['Romans 16:21', '1 Corinthians 4:17', 'Philippians 2:19-22', 'Colossians 1:1', 'Acts 16:1-3']
  ];
  const results = await extensionWorker.evaluate(cases => cases.map(lines =>
    extractBibleRefsFromSelectedTextUncached(lines.join('\n')).map(ref => ref.book)
  ), cases);

  expect(results[0]).toEqual(['romans', '1 corinthians', 'philippians']);
  expect(results[1]).toEqual(['1 corinthians', 'philippians']);
  expect(results[2]).toEqual(['philippians', 'colossians', 'romans', '1 corinthians']);
  expect(results[3]).toEqual(['romans', '1 corinthians', 'philippians', 'colossians', 'acts']);
});

test('Facebook selection parser preserves chapter-only refs alongside adjacent verse refs', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = [
      'Matthew 5:3-12',
      'Romans 8',
      '1 Peter 2:9-10'
    ].join('\n');
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from ?? null,
      to: ref.to ?? null
    }));
  });

  expect(result).toEqual([
    { book: 'matthew', chapter: 5, from: 3, to: 12 },
    { book: 'romans', chapter: 8, from: null, to: null },
    { book: '1 peter', chapter: 2, from: 9, to: 10 }
  ]);
});

test('Facebook selection parser keeps a chapter ref distinct from explicit verse one', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    return extractBibleRefsFromSelectedTextUncached('Romans 8\nRomans 8:1').map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from ?? null,
      to: ref.to ?? null
    }));
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 8, from: null, to: null },
    { book: 'romans', chapter: 8, from: 1, to: 1 }
  ]);
});

test('Facebook post selection extracts references split across separate post text blocks', async ({ extensionWorker }) => {
  // Mirrors the selected reference-bearing lines in the supplied Facebook post.
  // Each entry represents a separate dir="auto" text block in the post DOM.
  const result = await extensionWorker.evaluate(() => {
    const selectedBlocks = [
      'Mt.10:32-33',
      'Lk.12:33',
      'Romans 9-11',
      'Romans 16:25',
      'Eph. 3',
      'Col. 1:24-27',
      'Eph.3:1-3',
      '2 Tim.2:12',
      'Romans 1-5',
      'Mt.16:24-27',
      'Lk.21:36',
      'Romans 4:4-5',
      'Romans 8:17',
      'Romans14:10-12',
      '1Cor. 3: 5-15',
      '1Cor. 9:14-27',
      '2Cor. 5: 9-10',
      '2Cor. 9:6-7',
      'Phil. 3:10-14',
      'Phil.4:15-17',
      'Col. 2:4,8,18',
      'Col.3:23-25',
      '2Tim.2:10-15',
      'Titus 3:8'
    ];
    return extractBibleRefsFromSelectedTextUncached(selectedBlocks.join('\n')).map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from ?? null, to: ref.to ?? null
    }));
  });

  // Chapter-only ranges expand to every chapter, and comma-separated verses
  // remain separate reference entries; the output therefore exceeds 24 blocks.
  expect(result.length).toBeGreaterThanOrEqual(24);
  expect([...new Set(result.map(ref => ref.book))]).toEqual([
    'matthew','luke','romans','ephesians','colossians','2 timothy',
    '1 corinthians','2 corinthians','philippians','titus'
  ]);
  expect(result.filter(ref => ref.book === 'romans' && [9,10,11].includes(ref.chapter))
    .map(ref => ref.chapter)).toEqual([9,10,11]);
  expect([...new Set(result.filter(ref => ref.book === 'romans' && [1,2,3,4,5].includes(ref.chapter))
    .map(ref => ref.chapter))].sort((a,b) => a-b)).toEqual([1,2,3,4,5]);
  expect(result.some(ref => ref.book === 'romans' && ref.chapter === 4 && ref.from === 4 && ref.to === 5)).toBe(true);
  expect(result.filter(ref => ref.book === 'colossians' && ref.chapter === 2)
    .map(ref => ref.from).sort((a,b) => a-b)).toEqual([4,8,18]);
});


test('Facebook selection parser does not reinterpret a chapter:verse range as a chapter range', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() =>
    extractBibleRefsFromSelectedTextUncached('Romans 4:4-5').map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to
    }))
  );
  expect(result).toEqual([{book:'romans',chapter:4,from:4,to:5}]);
});


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

test('Facebook supplied div[dir=auto] DOM opens shorthand references from numeric clicks', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'facebook.com': true, 'www.facebook.com': true } });
  await page.route('https://www.facebook.com/**', route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: '<!doctype html><html><head><title>Facebook exact DOM fixture</title></head><body></body></html>'
  }));
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const outer = document.createElement('div');
    outer.id = 'fb-godliness-exact-dom';
    outer.setAttribute('data-blb-test-diagnostics', 'true');
    outer.className = 'html-div xdj266r x14z9mp xat24cr x1lziwak xexx8yu xyri2b x18d9i69 x1c1uobl';
    outer.innerHTML = '<div class="xdj266r x14z9mp xat24cr x1lziwak x1vvkbs x126k92a"></div>' +
      '<div class="x14z9mp xat24cr x1lziwak x1vvkbs xtlvy1s x126k92a"><div id="godliness-paragraph" dir="auto" style="text-align:start"></div></div>';
    const paragraph = outer.querySelector('#godliness-paragraph');
    paragraph.textContent = '1 Timothy 3:16 And without controversy great is the mystery of godliness: God was manifest in the flesh [the mystery of godliness is that Christ is manifesting Himself through the believers Gal. 2:20, 4:6; Rom. 5:5, 8:9; 1 Cor. 6:19; 2 Cor. 1:22, 4:7, 10, 11; Eph. 3:16, 17; Phil. 2:13; Col. 1:27; 2 Tim. 1:7] justified in the Spirit [we are declared justified when His Spirit is in us Rom. 3:26], seen of angels [the angels are watching us 1 Cor. 4:9, 1 Cor. 11:10; Eph. 3:10], preached unto the Gentiles [Paul preached Jesus Christ according to the revelation of the mystery Rom. 16:25-27; Acts 13:42, 18:6, 28:28; Rom. 11:11-13; Col. 1:23], believed on in the world [Eph. 1:7, 13, 14, 2:8, 9; Col. 1:6], received up into glory [1 Thess. 4:15-17; 1 Cor. 15:51-53].';
    outer.style.cssText = 'max-width:900px;margin:24px auto;padding:16px;background:#fff;color:#111;font:20px/1.6 Arial,sans-serif;';
    document.body.appendChild(outer);
  });
  await page.evaluate(() => {
    window.__fbLastDblClick = null;
    document.addEventListener('dblclick', event => {
      let caret = null;
      try {
        const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
        caret = range ? {
          nodeType: range.startContainer.nodeType,
          nodeName: range.startContainer.nodeName,
          offset: range.startOffset,
          text: range.startContainer.nodeValue || range.startContainer.textContent || ''
        } : null;
      } catch (_) {}
      window.__fbLastDblClick = {
        targetTag: event.target?.tagName || null,
        targetId: event.target?.id || null,
        targetText: (event.target?.textContent || '').slice(0, 100),
        selected: window.getSelection?.()?.toString() || '',
        clientX: event.clientX,
        clientY: event.clientY,
        caret
      };
    }, true);
  });

  const cases = [
    { context: 'Gal. 2:20, 4:6', token: '4', expected: '/kjv/gal/4/6/' },
    { context: 'Gal. 2:20, 4:6', token: '6', expected: '/kjv/gal/4/6/' },
    { context: 'Eph. 1:7, 13, 14, 2:8, 9', token: '9', expected: '/kjv/eph/2/9/' },
    { context: '2 Cor. 1:22, 4:7, 10, 11', token: '10', expected: '/kjv/2co/4/10/' },
    { context: 'Acts 13:42, 18:6, 28:28', token: '28', expected: '/kjv/act/28/28/' }
  ];
  for (const item of cases) {
    const point = await page.evaluate(({ context, token }) => {
      const root = document.querySelector('#godliness-paragraph');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const contextStart = node.nodeValue.indexOf(context);
        if (contextStart < 0) continue;
        const tokenOffset = context.lastIndexOf(token);
        const range = document.createRange();
        range.setStart(node, contextStart + tokenOffset);
        range.setEnd(node, contextStart + tokenOffset + token.length);
        const before = range.getBoundingClientRect();
        window.scrollTo(0, before.top + window.scrollY - window.innerHeight / 2);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return null;
    }, item);
    expect(point, item.context + ' token ' + item.token).not.toBeNull();
    await page.mouse.dblclick(point.x, point.y);
    let observedTabs = [];
    try {
      await expect.poll(async () => {
        observedTabs = await extensionWorker.evaluate(async () => (await chrome.tabs.query({}))
          .map(tab => tab.pendingUrl || tab.url || ''));
        return observedTabs.map(value => {
          try { return new URL(value).pathname; } catch (_) { return ''; }
        }).find(pathname => pathname === item.expected) || null;
      }, { timeout: 10000 }).toBe(item.expected);
    } catch (error) {
      const clickDiagnostic = await page.evaluate(() => ({
        event: window.__fbLastDblClick,
        resolver: document.querySelector('#fb-godliness-exact-dom')?.getAttribute('data-blb-numeric-context-diagnostic') || null
      }));
      throw new Error(error.message + '\\nObserved tabs: ' + JSON.stringify(observedTabs) +
        '\\nClick diagnostic: ' + JSON.stringify(clickDiagnostic));
    }
    const opened = await extensionWorker.evaluate(async () => (await chrome.tabs.query({}))
      .filter(tab => {
        try { return new URL(tab.pendingUrl || tab.url || '').hostname === 'www.blueletterbible.org'; }
        catch (_) { return false; }
      }).map(tab => tab.id));
    for (const id of opened) await extensionWorker.evaluate(tabId => chrome.tabs.remove(tabId).catch(() => {}), id);
  }
});
