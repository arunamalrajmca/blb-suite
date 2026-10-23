const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

function readHostnameSet(source, constantName) {
  const escapedName = constantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(
    `const ${escapedName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`
  ));
  expect(match, `Could not find ${constantName} hostname set`).toBeTruthy();
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]);
}

test('native redirect hostname lists stay normalized and in sync', () => {
  const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');

  const backgroundHosts = readHostnameSet(background, 'REDIRECT_HOSTNAMES');
  const contentHosts = readHostnameSet(content, 'REDIRECT_HOSTS');

  expect(backgroundHosts.length).toBeGreaterThan(0);
  expect(new Set(backgroundHosts).size).toBe(backgroundHosts.length);
  expect(new Set(contentHosts).size).toBe(contentHosts.length);
  expect(backgroundHosts).not.toContain('www.blueletterbible.org');
  expect(backgroundHosts.every(host => host === host.toLowerCase() && !host.startsWith('www.'))).toBe(true);
  expect([...contentHosts].sort()).toEqual([...backgroundHosts].sort());

  // Both call sites must normalize incoming hostnames before set membership.
  expect(background).toContain('normalizeSiteHostname(u.hostname)');
  expect(content).toMatch(/REDIRECT_HOSTS\.has\(location\.hostname\.toLowerCase\(\)\.replace\(\/\^www\\\.\/\s*,\s*['"]['"]\)\)/);
});

test('bare and www source hostnames normalize to the same native redirect key', () => {
  const normalize = hostname => hostname.toLowerCase().replace(/^www\./, '');
  const supported = new Set([
    'bible.com',
    'biblegateway.com',
    'bibleref.com',
    'biblehub.com',
    'bibleportal.com',
    'kingjamesbibleonline.org',
    'kjbo.org',
    'kjv.site',
    'm.kjv.site',
    'officialkingjamesbible.com',
    'thekingsbible.com',
    'webstersdictionary1828.com',
    'blueletterbible.org'
  ]);

  for (const host of supported) {
    expect(supported.has(normalize(host))).toBe(true);
    expect(supported.has(normalize(`www.${host}`))).toBe(true);
  }
});
