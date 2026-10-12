const { test, expect } = require('./fixtures');

test('hostname text never enables Show on BLB by default', async ({ extensionWorker }) => {
  const hostnames = [
    'bible.com',
    'www.bible.com',
    'mybible.example',
    'bible-host.example.org',
    'blueletterbible.org',
    'example.com'
  ];

  const results = await extensionWorker.evaluate(async (hosts) => {
    const output = {};
    for (const hostname of hosts) {
      output[hostname] = await chrome.runtime.sendMessage({
        type: 'blbSuiteGetDefaultSiteStatus',
        hostname
      });
    }
    return output;
  }, hostnames);

  for (const hostname of hostnames) {
    expect(results[hostname], hostname).toMatchObject({ ok: true, enabled: false });
  }
});

test('sensitive-site feature toggles are blocked even when the user has opted in', async ({ extensionWorker }) => {
  const results = await extensionWorker.evaluate(async () => {
    const cases = [
      'https://secure.bank.example/',
      'https://portal.hospital.example/',
      'https://member.insurance.example/',
      'https://example.com/'
    ];
    const output = {};
    for (const origin of cases) {
      output[origin] = await chrome.runtime.sendMessage({
        type: 'blbSuitePrepareSiteFeatureToggle',
        origin,
        feature: 'pageButton',
        otherFeatureEnabled: true
      });
    }
    return output;
  });
  expect(results['https://secure.bank.example/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://portal.hospital.example/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://member.insurance.example/']).toMatchObject({ ok: false, blockedSensitiveSite: true });
  expect(results['https://example.com/']).not.toMatchObject({ blockedSensitiveSite: true });
});
