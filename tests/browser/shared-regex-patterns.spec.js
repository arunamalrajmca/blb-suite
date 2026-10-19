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


test('Facebook-style multiline reference lists retain every explicitly named reference', async ({ extensionWorker }) => {
  const cases = await extensionWorker.evaluate(() => {
    const first = [
      'Acts 16:1-3',
      'Romans 16:21',
      '1 Corinthians 4:17',
      'Philippians 2:19-22',
      'Colossians 1:1'
    ].join('\n');
    const second = [
      'Romans 16:24',
      '1 Corinthians 16:23',
      '2 Corinthians 13:14',
      'Galatians 6:18',
      'Ephesians 6:24',
      'Philippians 4:23',
      'Colossians 4:18',
      '1 Thessalonians 5:28',
      '2 Thessalonians 3:18',
      '1 Timothy 6:21',
      '2 Timothy 4:22',
      'Titus 3:15',
      'Philemon 25'
    ].join('\n');
    const map = text => extractBibleRefsFromSelectedTextUncached(text)
      .map(ref => [ref.book, ref.chapter, ref.from, ref.to]);
    const normalizedSecond = normalizeSelectedScriptureText(second);
    const normalizedSecondRefs = extractBibleRefsFromSelectedTextUncached(normalizedSecond);
    const expandedSecond = expandMultiVerseRefsToVerses(normalizedSecondRefs)
      .map(ref => [ref.book, ref.chapter, ref.from, ref.to]);
    const canonicalSecond = canonicalMultiVerseSet(normalizedSecondRefs).refs
      .map(ref => [ref.book, ref.chapter, ref.from, ref.to]);
    return {
      first: map(first),
      second: map(second),
      normalizedSecond: map(normalizedSecond),
      canonicalSecond,
      expandedSecond
    };
  });

  expect(cases.first).toEqual([
    ['acts', 16, 1, 3],
    ['romans', 16, 21, 21],
    ['1 corinthians', 4, 17, 17],
    ['philippians', 2, 19, 22],
    ['colossians', 1, 1, 1]
  ]);
  const expectedSecond = [
    ['romans', 16, 24, 24],
    ['1 corinthians', 16, 23, 23],
    ['2 corinthians', 13, 14, 14],
    ['galatians', 6, 18, 18],
    ['ephesians', 6, 24, 24],
    ['philippians', 4, 23, 23],
    ['colossians', 4, 18, 18],
    ['1 thessalonians', 5, 28, 28],
    ['2 thessalonians', 3, 18, 18],
    ['1 timothy', 6, 21, 21],
    ['2 timothy', 4, 22, 22],
    ['titus', 3, 15, 15],
    ['philemon', 1, 25, 25]
  ];
  expect(cases.second).toEqual(expectedSecond);
  expect(cases.normalizedSecond).toEqual(expectedSecond);
  expect(cases.canonicalSecond).toEqual(expectedSecond);
  expect(cases.expandedSecond).toEqual(expectedSecond);
});
