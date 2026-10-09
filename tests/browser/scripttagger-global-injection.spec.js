const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const background = fs.readFileSync(path.resolve(__dirname, '../../extension/background.js'), 'utf8');

function extractFunction(name, nextMarker) {
  const start = background.indexOf(`async function ${name}(`);
  const end = background.indexOf(nextMarker, start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name} from extension/background.js`);
  return background.slice(start, end).trim();
}

function runInjectionHelper(functionNames, { settings, tabs }) {
  const injected = [];
  const chrome = {
    storage: { local: { get: async () => settings } },
    tabs: { query: async () => tabs }
  };
  const context = {
    chrome,
    injected,
    isHttpPageUrl: url => /^https?:\\/\\//i.test(String(url || '')),
    originPatternForUrl: url => {
      try {
        const parsed = new URL(String(url || ''));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? `${parsed.protocol}//${parsed.hostname}/*`
          : '';
      } catch (_) { return ''; }
    },
    normalizeSiteHostname: value => String(value || '').toLowerCase(),
    hostnameFromTabUrl: value => {
      try { return new URL(String(value || '')).hostname; } catch (_) { return ''; }
    },
    hasHostAccessForTab: async tab => tab.hostAccess === true,
    ensureContentScriptInTab: async id => { injected.push(id); return true; }
  };
  const snippets = [];
  for (const name of functionNames) {
    if (name === 'injectEnabledTabsForGrantedOrigins') {
      snippets.push(extractFunction(name, '\nasync function injectRedirectEnabledTabs'));
    } else {
      snippets.push(extractFunction(name, '\nchrome.permissions?.onAdded'));
    }
  }
  vm.runInNewContext(snippets.join('\n\n'), context);
  return { context, injected };
}

test.describe('global ScriptTagger content-script injection', () => {
  test('wildcard host grant activates an already-open unlisted website', async () => {
    const { context, injected } = runInjectionHelper(['injectEnabledTabsForGrantedOrigins'], {
      settings: { redirectEnabled: true, pageSelectionButtonSites: {}, doubleClickBlbSites: {} },
      tabs: [{ id: 42, url: 'https://sagacityweb.com/bible-reftagger-activated-for-sagacityweb/', hostAccess: true }]
    });

    await context.injectEnabledTabsForGrantedOrigins(['http://*/*', 'https://*/*']);
    expect(injected).toEqual([42]);
  });

  test('turning the global toggle on injects all already-open tabs with granted host access', async () => {
    const { context, injected } = runInjectionHelper(['injectRedirectEnabledTabs'], {
      settings: { redirectEnabled: true },
      tabs: [
        { id: 11, url: 'https://sagacityweb.com/article', hostAccess: true },
        { id: 12, url: 'https://example.org/article', hostAccess: true },
        { id: 13, url: 'https://restricted.example/article', hostAccess: false },
        { id: 14, url: 'chrome://settings', hostAccess: false }
      ]
    });

    await context.injectRedirectEnabledTabs();
    expect(injected).toEqual([11, 12]);
  });
});
