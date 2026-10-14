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
  ).map(ref => ({ book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to })));

  expect(refs).toContainEqual({ book: 'Proverbs', chapter: 10, from: 31, to: 31 });
  expect(refs).toContainEqual({ book: 'Proverbs', chapter: 15, from: 2, to: 2 });
  expect(refs).toContainEqual({ book: 'Proverbs', chapter: 21, from: 23, to: 23 });
  expect(refs).toContainEqual({ book: 'Ecclesiastes', chapter: 10, from: 12, to: 14 });
});

test('reference parser expands shorthand chapters and same-chapter comma verses', async ({ extensionWorker }) => {
  const refs = await extensionWorker.evaluate(() => resolveBibleReferenceText(
    'Job 5:21; Jas 3:9-12. Pr 12:18; 13:10; 14:16; 18:6-7,21; 21:24; 28:25; 29:20'
  ).map(ref => ({ book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to })));

  for (const expected of [
    { book: 'Proverbs', chapter: 12, from: 18, to: 18 },
    { book: 'Proverbs', chapter: 13, from: 10, to: 10 },
    { book: 'Proverbs', chapter: 14, from: 16, to: 16 },
    { book: 'Proverbs', chapter: 18, from: 6, to: 7 },
    { book: 'Proverbs', chapter: 18, from: 21, to: 21 },
    { book: 'Proverbs', chapter: 21, from: 24, to: 24 },
    { book: 'Proverbs', chapter: 28, from: 25, to: 25 },
    { book: 'Proverbs', chapter: 29, from: 20, to: 20 }
  ]) expect(refs).toContainEqual(expected);
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
