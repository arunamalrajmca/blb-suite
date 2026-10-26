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
  const hostPolicy = fs.readFileSync(path.join(root, 'extension/background-host-policy.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');

  const backgroundHosts = readHostnameSet(hostPolicy, 'redirectHostnames');
  const contentHosts = readHostnameSet(content, 'REDIRECT_HOSTS');

  expect(backgroundHosts.length).toBeGreaterThan(0);
  expect(new Set(backgroundHosts).size).toBe(backgroundHosts.length);
  expect(new Set(contentHosts).size).toBe(contentHosts.length);
  expect(backgroundHosts).not.toContain('www.blueletterbible.org');
  expect(hostPolicy).toContain('blbHostname');
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
    'christianity.com',
    'crosswalk.com',
    'enduringword.com',
    'esv.org',
    'gotquestions.org',
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

test('MAIN-world guard registration normalizes www hosts and is limited to article source sites', () => {
  // Registration lives in its dedicated service-worker module; keep this
  // contract aligned with that boundary instead of the background entrypoint.
  const registry = fs.readFileSync(path.join(root, 'extension/background-content-script-registry.js'), 'utf8');
  const registrationStart = registry.indexOf('let hostname = \'\';');
  const registrationEnd = registry.indexOf('const mainWorldId', registrationStart);
  expect(registrationStart).toBeGreaterThanOrEqual(0);
  expect(registrationEnd).toBeGreaterThan(registrationStart);
  const registration = registry.slice(registrationStart, registrationEnd);
  expect(registration).toContain("new URL(tab.url).hostname.toLowerCase().replace(/^www\\./, '')");
  expect(registration).not.toContain("replace(/^www\\\\./, '')");
  for (const host of ['christianity.com', 'gotquestions.org', 'crosswalk.com', 'enduringword.com']) {
    expect(registration).toContain(host);
  }
  // ESV.org is redirect-only; it does not need the source-page click guard.
  expect(registration).not.toContain("'esv.org'");
});

