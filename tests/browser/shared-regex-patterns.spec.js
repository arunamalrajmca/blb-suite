const { test, expect } = require('./fixtures');

test('shared regex catalog exposes stable BLB constants and independent regex instances', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const firstWhitespace = BLBShared.regex.whitespace();
    const secondWhitespace = BLBShared.regex.whitespace();
    firstWhitespace.test('one two');
    const independentState = secondWhitespace.lastIndex === 0;
    const booleanWords = BLBShared.regex.booleanOperatorWords();
    const operatorMatches = 'truth AND grace or peace'.match(booleanWords);
    return {
      hostname: BLBShared.hostnames.blb,
      origin: BLBShared.urls.blbOrigin,
      search: BLBShared.urls.blbSearch,
      independentState,
      operatorMatches
    };
  });

  expect(result.hostname).toBe('blueletterbible.org');
  expect(result.origin).toBe('https://www.blueletterbible.org');
  expect(result.search).toBe('https://www.blueletterbible.org/search/search.cfm');
  expect(result.independentState).toBe(true);
  expect(result.operatorMatches).toEqual(['AND', 'or']);
});


test('reference parser expands abbreviated book context in semicolon lists', async ({ extensionWorker }) => {
  const refs = await extensionWorker.evaluate(() => resolveBibleReferenceText(
    '(Pr 10:20,31; 15:2; 21:23; Eccl 10:12-14)'
  ).map(ref => [ref.book, ref.chapter, ref.from, ref.to]));

  expect(refs).toEqual([
    ['proverbs', 10, 20, 20],
    ['proverbs', 10, 31, 31],
    ['proverbs', 15, 2, 2],
    ['proverbs', 21, 23, 23],
    ['ecclesiastes', 10, 12, 14]
  ]);
});

test('reference parser expands shorthand chapters and same-chapter comma verses in source order', async ({ extensionWorker }) => {
  const refs = await extensionWorker.evaluate(() => resolveBibleReferenceText(
    'Job 5:21; Jas 3:9-12. Pr 12:18; 13:10; 14:16; 18:6-7,21; 21:24; 28:25; 29:20'
  ).map(ref => [ref.book, ref.chapter, ref.from, ref.to]));

  expect(refs).toEqual([
    ['job', 5, 21, 21],
    ['james', 3, 9, 12],
    ['proverbs', 12, 18, 18],
    ['proverbs', 13, 10, 10],
    ['proverbs', 14, 16, 16],
    ['proverbs', 18, 6, 7],
    ['proverbs', 18, 21, 21],
    ['proverbs', 21, 24, 24],
    ['proverbs', 28, 25, 25],
    ['proverbs', 29, 20, 20]
  ]);
});


test('reference parser normalizes Unicode mathematical-bold Bible references', async ({ extensionWorker }) => {
  const refs = await extensionWorker.evaluate(() => ({
    styled: resolveBibleReferenceText('𝐏𝐫𝐨𝐯𝐞𝐫𝐛𝐬 𝟏𝟒:𝟑')
      .map(ref => [ref.book, ref.chapter, ref.from, ref.to]),
    ordinary: resolveBibleReferenceText('Proverbs 14:3')
      .map(ref => [ref.book, ref.chapter, ref.from, ref.to])
  }));

  expect(refs.styled).toEqual([['proverbs', 14, 3, 3]]);
  expect(refs.ordinary).toEqual([['proverbs', 14, 3, 3]]);
});

test('reference parser accepts verse-part suffixes without changing the destination verse', async ({ extensionWorker }) => {
  const refs = await extensionWorker.evaluate(() => ({
    esther: resolveBibleReferenceText('"...such a time as this." (Esther 4:14c)')
      .map(ref => [ref.book, ref.chapter, ref.from, ref.to, ref.url]),
    romans: resolveBibleReferenceText('"For whatsoever things were written aforetime..." (Romans 15:4a)')
      .map(ref => [ref.book, ref.chapter, ref.from, ref.to, ref.url])
  }));

  expect(refs.esther).toEqual([[
    'esther', 4, 14, 14, 'https://www.blueletterbible.org/kjv/est/4/14/'
  ]]);
  expect(refs.romans).toEqual([[
    'romans', 15, 4, 4, 'https://www.blueletterbible.org/kjv/rom/15/4/'
  ]]);
});

test('shared sensitive-site classifier covers known providers without keyword false positives', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => ({
    chase: BLBShared.isSensitiveSiteHostname('chase.com'),
    citiSubdomain: BLBShared.isSensitiveSiteHostname('online.citi.com'),
    indianBank: BLBShared.isSensitiveSiteHostname('www.hdfcbank.com'),
    patientPortal: BLBShared.isSensitiveSiteHostname('portal.mychart.com'),
    hospital: BLBShared.isSensitiveSiteHostname('apollohospitals.com'),
    insurance: BLBShared.isSensitiveSiteHostname('member.aetna.com'),
    government: BLBShared.isSensitiveSiteHostname('agency.example.gov'),
    governmentSubdomain: BLBShared.isSensitiveSiteHostname('portal.department.example.gov'),
    indianGovernment: BLBShared.isSensitiveSiteHostname('services.example.gov.in'),
    ukGovernment: BLBShared.isSensitiveSiteHostname('portal.department.example.gov.uk'),
    scottishGovernment: BLBShared.isSensitiveSiteHostname('portal.department.gov.scot'),
    welshGovernment: BLBShared.isSensitiveSiteHostname('services.gov.wales'),
    governmentTld: BLBShared.isSensitiveSiteHostname('agency.gov'),
    lookalikeGov: BLBShared.isSensitiveSiteHostname('example.gov.com'),
    healthInformationSite: BLBShared.isSensitiveSiteHostname('healthline.com'),
    financeContentSubdomain: BLBShared.isSensitiveSiteHostname('finance.yahoo.com'),
    unrelated: BLBShared.isSensitiveSiteHostname('example.com')
  }));
  expect(result).toMatchObject({
    chase: true,
    citiSubdomain: true,
    indianBank: true,
    patientPortal: true,
    hospital: true,
    insurance: true,
    government: true,
    governmentSubdomain: true,
    indianGovernment: true,
    ukGovernment: true,
    scottishGovernment: true,
    welshGovernment: true,
    governmentTld: true,
    lookalikeGov: false,
    healthInformationSite: false,
    financeContentSubdomain: false,
    unrelated: false
  });
});

test('Facebook-style DOM range extraction preserves all block-separated references before MultiVerse parsing', async ({ context, extensionWorker }) => {
  const page = await context.newPage();
  await page.setContent(`
    <article id="post">
      <div>Acts 16:1-3</div>
      <div>Romans 16:21</div>
      <div>1 Corinthians 4:17</div>
      <div>Philippians 2:19-22</div>
      <div>Colossians 1:1</div>
    </article>
    <div class="x14z9mp xat24cr x1lziwak x1vvkbs xtlvy1s x126k92a" id="post2">
      <div dir="auto" style="text-align:start">Romans 16:24</div>
      <div dir="auto" style="text-align:start">1 Corinthians 16:23</div>
      <div dir="auto" style="text-align:start">2 Corinthians 13:14</div>
      <div dir="auto" style="text-align:start">Galatians 6:18</div>
      <div dir="auto" style="text-align:start">Ephesians 6:24</div>
      <div dir="auto" style="text-align:start">Philippians 4:23</div>
      <div dir="auto" style="text-align:start">Colossians 4:18</div>
      <div dir="auto" style="text-align:start">1 Thessalonians 5:28</div>
      <div dir="auto" style="text-align:start">2 Thessalonians 3:18</div>
      <div dir="auto" style="text-align:start">1 Timothy 6:21</div>
      <div dir="auto" style="text-align:start">2 Timothy 4:22</div>
      <div dir="auto" style="text-align:start">Titus 3:15</div>
      <div dir="auto" style="text-align:start">Philemon 25</div>
      <div dir="auto" style="text-align:start">3. The Ancient Church Often Accepted Paul as the Author</div>
      <div dir="auto" style="text-align:start">The Eastern church especially associated Hebrews with Paul.</div>
    </article>`);
  const selected = await page.evaluate(() => {
    const blockTags = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DIV','DL','DT','DD','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL']);
    const extract = element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const pieces = [];
      const walk = node => {
        if (node.nodeType === Node.TEXT_NODE) { pieces.push(node.nodeValue || ''); return; }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') { pieces.push('\n'); return; }
        const isBlock = node.nodeType === Node.ELEMENT_NODE && blockTags.has(node.tagName);
        if (isBlock && pieces.length && !String(pieces[pieces.length - 1]).endsWith('\n')) pieces.push('\n');
        for (const child of node.childNodes) walk(child);
        if (isBlock && pieces.length && !String(pieces[pieces.length - 1]).endsWith('\n')) pieces.push('\n');
      };
      walk(range.cloneContents());
      return pieces.join('').replace(/\u00a0/g, ' ').replace(/[ \\t]*\n[ \\t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    return [extract(document.querySelector('#post')), extract(document.querySelector('#post2'))];
  });
  const parsed = await extensionWorker.evaluate(texts => texts.map(text =>
    extractBibleRefsFromSelectedTextUncached(normalizeSelectedScriptureText(text))
      .map(ref => [ref.book, ref.chapter, ref.from, ref.to])
  ), selected);
  expect(parsed[0]).toEqual([
    ['acts', 16, 1, 3], ['romans', 16, 21, 21],
    ['1 corinthians', 4, 17, 17], ['philippians', 2, 19, 22],
    ['colossians', 1, 1, 1]
  ]);
  expect(parsed[1]).toEqual([
    ['romans', 16, 24, 24], ['1 corinthians', 16, 23, 23],
    ['2 corinthians', 13, 14, 14], ['galatians', 6, 18, 18],
    ['ephesians', 6, 24, 24], ['philippians', 4, 23, 23],
    ['colossians', 4, 18, 18], ['1 thessalonians', 5, 28, 28],
    ['2 thessalonians', 3, 18, 18], ['1 timothy', 6, 21, 21],
    ['2 timothy', 4, 22, 22], ['titus', 3, 15, 15], ['philemon', 1, 25, 25]
  ]);
  await page.close();
});

test('mixed reference selection keeps the paired Timothy book shorthand visible for explicit handling', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const text = 'Acts 16:1-3\nRomans 16:21\n1 Corinthians 4:17\nPhilippians 2:19-22\nColossians 1:1\n1 & 2 Timothy';
    const wholeBooks = getSelectedWholeBookReferencesFromMixedText(text);
    return {
      verseRefs: extractBibleRefsFromSelectedTextUncached(normalizeSelectedScriptureText(text))
        .map(ref => [ref.book, ref.chapter, ref.from, ref.to]),
      wholeBooks: wholeBooks.map(ref => [ref.book, ref.chapter, ref.from, ref.to]),
      normalized: normalizeSelectedScriptureText(text)
    };
  });
  expect(result.verseRefs).toEqual([
    ['acts', 16, 1, 3], ['romans', 16, 21, 21],
    ['1 corinthians', 4, 17, 17], ['philippians', 2, 19, 22],
    ['colossians', 1, 1, 1]
  ]);
  expect(result.normalized).toContain('1 & 2 Timothy');
  expect(result.wholeBooks.length).toBeGreaterThan(0);
  expect(result.wholeBooks[0][0]).toBe('1 timothy');
  expect(result.wholeBooks.some(ref => ref[0] === '2 timothy')).toBe(true);
  expect(result.wholeBooks.filter(ref => ref[0] === '1 timothy').map(ref => ref[1]))
    .toEqual(Array.from({length: 6}, (_, index) => index + 1));
  expect(result.wholeBooks.filter(ref => ref[0] === '2 timothy').map(ref => ref[1]))
    .toEqual(Array.from({length: 4}, (_, index) => index + 1));
});



test('paired 1 & 2 Timothy whole-book shorthand reaches the final MultiVerse POST with every chapter', async ({ context, extensionWorker }) => {
  const submittedPayloads = [];
  await context.route('https://www.blueletterbible.org/**', route => {
    if (route.request().method() === 'POST') {
      submittedPayloads.push(new URLSearchParams(route.request().postData() || '').get('mvText') || '');
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    });
  });

  const selectedText = [
    'Acts 16:1-3',
    'Romans 16:21',
    '1 Corinthians 4:17',
    'Philippians 2:19-22',
    'Colossians 1:1',
    '1 & 2 Timothy'
  ].join('\n');

  await extensionWorker.evaluate(async text => {
    await openSelectedPdfBibleRefs(text, {activeIfNew:true, activateExisting:true});
  }, selectedText);

  // This selection expands to 206 verses, so it must generate two POST batches.
  // Wait for both handoff pages to submit before asserting cross-batch coverage.
  await expect.poll(() => submittedPayloads.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);

  const postedRefs = submittedPayloads
    .flatMap(payload => payload.split(';'))
    .map(reference => reference.trim().toLowerCase())
    .filter(Boolean);

  // Check the actual outbound MultiVerse payload, not just the parser helper:
  // the five explicit verse references and all ten whole-book chapter ranges
  // must survive the selection-to-POST path.
  for (const reference of [
    'acts 16:1-3',
    'romans 16:21',
    '1 corinthians 4:17',
    'philippians 2:19-22',
    'colossians 1:1'
  ]) {
    expect(postedRefs, 'missing explicit reference: ' + reference).toContain(reference);
  }

  const chapterVerseCounts = {
    '1 timothy': [20, 15, 16, 16, 25, 21],
    '2 timothy': [18, 26, 17, 22]
  };
  // The 200-verse MultiVerse cap can split a chapter across two POST batches.
  // Verify coverage of every verse rather than requiring each chapter to be
  // serialized as one unsplit range in a single batch.
  const postedRanges = postedRefs.map(reference => {
    const match = /^(.*?) (\d+):(\d+)-(\d+)$/.exec(reference);
    return match && {
      book: match[1],
      chapter: Number(match[2]),
      from: Number(match[3]),
      to: Number(match[4])
    };
  }).filter(Boolean);
  for (const [book, verseCounts] of Object.entries(chapterVerseCounts)) {
    for (let index = 0; index < verseCounts.length; index++) {
      const chapter = index + 1;
      const lastVerse = verseCounts[index];
      for (let verse = 1; verse <= lastVerse; verse++) {
        const covered = postedRanges.some(range =>
          range.book === book &&
          range.chapter === chapter &&
          range.from <= verse &&
          range.to >= verse
        );
        expect(covered, `missing whole-book verse: ${book} ${chapter}:${verse}`).toBe(true);
      }
    }
  }
});

test('Facebook reference selections survive canonical MultiVerse expansion through final selected verses', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const facebookText = [
      'Romans 16:24', '1 Corinthians 16:23', '2 Corinthians 13:14',
      'Galatians 6:18', 'Ephesians 6:24', 'Philippians 4:23',
      'Colossians 4:18', '1 Thessalonians 5:28', '2 Thessalonians 3:18',
      '1 Timothy 6:21', '2 Timothy 4:22', 'Titus 3:15', 'Philemon 25',
      '3. The Ancient Church Often Accepted Paul as the Author',
      'The Eastern church especially associated Hebrews with Paul.'
    ].join('\n');
    const explicit = extractBibleRefsFromSelectedTextUncached(normalizeSelectedScriptureText(facebookText));
    const expanded = expandMultiVerseRefsToVerses(explicit);
    const verseKeys = new Set(expanded.map(ref => `${ref.book}|\${ref.chapter}|\${ref.from}`));
    const finalVerseRefs = [
      ['2 corinthians', 13, 14], ['colossians', 4, 18],
      ['2 timothy', 4, 22], ['titus', 3, 15]
    ];
    const canonicalBooks = Object.fromEntries(BOOKS.map(book => [book.name.toLowerCase(), book]));
    const finalVerses = finalVerseRefs.map(([bookName, chapter, verse]) => {
      const book = canonicalBooks[bookName];
      return {book:book.name, bookNumber:book.bookNumber, chapter, from:verse, to:verse, version:'kjv'};
    });
    const explicitRefs = explicit.map(ref => [ref.book, ref.chapter, ref.from, ref.to]);
    const expandedFinals = finalVerseRefs.map(([bookName, chapter, verse]) =>
      expanded.some(ref => ref.book.toLowerCase() === bookName && ref.chapter === chapter && ref.from === verse)
    );
    const caseA = [
      'Acts 16:1-3', 'Romans 16:21', '1 Corinthians 4:17',
      'Philippians 2:19-22', 'Colossians 1:1', '1 & 2 Timothy'
    ].join('\n');
    const caseARefs = extractBibleRefsFromSelectedTextUncached(normalizeSelectedScriptureText(caseA));
    const caseAWholeBooks = getSelectedWholeBookReferencesFromMixedText(caseA);
    const caseAExpanded = expandMultiVerseRefsToVerses([...caseARefs, ...caseAWholeBooks]);
    return {
      explicitRefs,
      expandedCount: expanded.length,
      expandedFinals,
      finalVerses: finalVerses.map(ref => [ref.book, ref.chapter, ref.from]),
      caseARefs: caseARefs.map(ref => [ref.book, ref.chapter, ref.from, ref.to]),
      timothyChapters: {
        first: [...new Set(caseAExpanded.filter(ref => ref.book.toLowerCase() === '1 timothy').map(ref => ref.chapter))],
        second: [...new Set(caseAExpanded.filter(ref => ref.book.toLowerCase() === '2 timothy').map(ref => ref.chapter))]
      },
      maxBatchCount: Math.ceil(caseAExpanded.length / BLB_MULTIVERSE_MAX_VERSES),
      hasTrailingProse: facebookText.includes('associated Hebrews with Paul')
    };
  });
  expect(result.explicitRefs).toHaveLength(13);
  expect(result.explicitRefs.map(ref => ref[0])).toEqual([
    'romans', '1 corinthians', '2 corinthians', 'galatians', 'ephesians',
    'philippians', 'colossians', '1 thessalonians', '2 thessalonians',
    '1 timothy', '2 timothy', 'titus', 'philemon'
  ]);
  expect(result.expandedFinals).toEqual([true, true, true, true]);
  expect(result.hasTrailingProse).toBe(true);
  expect(result.caseARefs).toEqual([
    ['acts', 16, 1, 3], ['romans', 16, 21, 21],
    ['1 corinthians', 4, 17, 17], ['philippians', 2, 19, 22],
    ['colossians', 1, 1, 1]
  ]);
  expect(result.timothyChapters.first).toEqual([1, 2, 3, 4, 5, 6]);
  expect(result.timothyChapters.second).toEqual([1, 2, 3, 4]);
  expect(result.maxBatchCount).toBeGreaterThan(1);
});


test('all reference orders preserve the middle selection through parsing and final MultiVerse POST', async ({ context, extensionWorker }) => {
  const submittedPayloads = [];
  await context.route('https://www.blueletterbible.org/**', route => {
    if (route.request().method() === 'POST') {
      submittedPayloads.push(new URLSearchParams(route.request().postData() || '').get('mvText') || '');
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    });
  });

  const permutations = [
    ['Romans 16:21', '1 Corinthians 4:17', 'Philippians 2:19-22'],
    ['Romans 16:21', 'Philippians 2:19-22', '1 Corinthians 4:17'],
    ['1 Corinthians 4:17', 'Romans 16:21', 'Philippians 2:19-22'],
    ['1 Corinthians 4:17', 'Philippians 2:19-22', 'Romans 16:21'],
    ['Philippians 2:19-22', 'Romans 16:21', '1 Corinthians 4:17'],
    ['Philippians 2:19-22', '1 Corinthians 4:17', 'Romans 16:21']
  ];
  const expectedByReference = {
    'Romans 16:21': ['romans', 16, 21, 21],
    '1 Corinthians 4:17': ['1 corinthians', 4, 17, 17],
    'Philippians 2:19-22': ['philippians', 2, 19, 22]
  };
  const expectedByPermutation = permutations.map(lines =>
    lines.map(reference => expectedByReference[reference])
  );

  const parsed = await extensionWorker.evaluate(cases => cases.map(lines => {
    const refs = extractBibleRefsFromSelectedTextUncached(normalizeSelectedScriptureText(lines.join('\n')));
    const expanded = expandMultiVerseRefsToVerses(refs);
    return {
      refs: refs.map(ref => [ref.book, ref.chapter, ref.from, ref.to]),
      expanded: expanded.map(ref => [ref.book, ref.chapter, ref.from])
    };
  }), permutations);

  for (let i = 0; i < parsed.length; i++) {
    const expected = expectedByPermutation[i];
    expect(parsed[i].refs, 'parser permutation ' + i).toEqual(expected);
    for (const [book, chapter, from, to] of expected) {
      for (let verse = from; verse <= to; verse++) {
        expect(parsed[i].expanded, 'expanded permutation ' + i).toContainEqual([book, chapter, verse]);
      }
    }
  }

  const submitted = await extensionWorker.evaluate(async () => {
    const refs = extractBibleRefsFromSelectedTextUncached(normalizeSelectedScriptureText(
      'Philippians 2:19-22\nRomans 16:21\n1 Corinthians 4:17'
    ));
    return openBlbMultiVerseRefs(refs, true);
  });
  expect(submitted?.ok, JSON.stringify(submitted)).toBe(true);
  expect(submitted?.count).toBe(6);
  await expect.poll(() => submittedPayloads.length, { timeout: 15000 }).toBeGreaterThan(0);

  const postRefs = submittedPayloads.flatMap(payload => payload.split(';').map(item => item.trim().toLowerCase()));
  expect(postRefs).toContain('romans 16:21');
  expect(postRefs).toContain('1 corinthians 4:17');
  expect(postRefs).toContain('philippians 2:19-22');
});
