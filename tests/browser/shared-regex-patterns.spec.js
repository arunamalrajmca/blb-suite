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
    governmentTld: true,
    lookalikeGov: false,
    healthInformationSite: false,
    financeContentSubdomain: false,
    unrelated: false
  });
});
