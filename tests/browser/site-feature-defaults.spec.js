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
