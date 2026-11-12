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

test('every production redirect hostname normalizes bare, www, and uppercase variants to its registered key', () => {
  const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
  const backgroundHosts = readHostnameSet(background, 'REDIRECT_HOSTNAMES');
  const contentHosts = readHostnameSet(content, 'REDIRECT_HOSTS');
  const normalize = hostname => hostname.toLowerCase().replace(/^www\./, '');

  // Use the production sets as the source of truth. Adding a supported
  // redirect hostname automatically adds its normalization cases here.
  expect([...contentHosts].sort()).toEqual([...backgroundHosts].sort());
  for (const host of backgroundHosts) {
    expect(normalize(host), host).toBe(host);
    expect(normalize(`www.${host}`), host).toBe(host);
    expect(normalize(host.toUpperCase()), host).toBe(host);
    expect(normalize(`WWW.${host.toUpperCase()}`), host).toBe(host);
    expect(backgroundHosts, host).toContain(normalize(`www.${host}`));
  }
});

test('MAIN-world guard registration normalizes www hosts and is limited to article source sites', () => {
  const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
  const registry = fs.readFileSync(path.join(root, 'extension/source-page-collector-sites.js'), 'utf8');
  const registrationStart = background.indexOf('let hostname = \'\';');
  const registrationEnd = background.indexOf('const mainWorldId', registrationStart);
  expect(registrationStart).toBeGreaterThanOrEqual(0);
  expect(registrationEnd).toBeGreaterThan(registrationStart);
  const registration = background.slice(registrationStart, registrationEnd);
  expect(registration).toContain("new URL(tab.url).hostname.toLowerCase().replace(/^www\\./, '')");
  expect(registration).not.toContain("replace(/^www\\\\./, '')");
  expect(registration).toContain('collectorConfig?.mainWorldClickGuard === true');
  expect(registration).not.toContain('christianity.com');
  for (const host of ['christianity.com', 'gotquestions.org', 'crosswalk.com', 'enduringword.com', 'churchofjesuschrist.org', 'mercyhouseministry.com', 'openbible.info', 'crossway.org', 'sarata.com']) {
    const entry = registry.split('\n').find(line => line.includes(`"${host}"`));
    expect(entry, `${host} must be configured in the shared registry`).toContain('mainWorldClickGuard:true');
  }
  // ESV.org is redirect-only; it does not need the source-page click guard.
  expect(registry).not.toContain('"esv.org"');
});

