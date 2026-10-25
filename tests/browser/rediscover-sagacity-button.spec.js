const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');

const hosts = ['rediscover.bible', 'sagacityweb.com'];

test('Rediscover and Sagacity are declared content-script and host-permission targets', () => {
  const script = manifest.content_scripts.find(item => item.js.includes('content.js'));
  expect(script).toBeTruthy();
  for (const host of hosts) {
    expect(script.matches).not.toContain(`https://${host}/*`);
    expect(script.matches).not.toContain(`https://www.${host}/*`);
    expect(manifest.host_permissions).not.toContain(`https://${host}/*`);
    expect(manifest.host_permissions).not.toContain(`https://www.${host}/*`);
    expect(manifest.optional_host_permissions).toContain('https://*/*');
  }
});

test('Show on BLB defaults on for these sites while homepage and double-click rules stay separate', () => {
  expect(background).toContain("return host === 'rediscover.bible' || host === 'sagacityweb.com';");
  expect(background).toContain("url.pathname.split('/').join('') === ''");
  expect(content).toContain("(host === 'rediscover.bible' || host === 'sagacityweb.com') && pathname === '/'");
  expect(content).toContain("const buttonOnlyDefaultSite = siteKey === 'rediscover.bible' || siteKey === 'sagacityweb.com';");
});
