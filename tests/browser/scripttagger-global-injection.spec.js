const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const background = fs.readFileSync(path.resolve(__dirname, '../../extension/background.js'), 'utf8');
const contentScript = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');

function runBlbUrlNormalizer() {
  const start = contentScript.indexOf('function normalizeBlbDestinationUrl(');
  const end = contentScript.indexOf('\nfunction openBlbDestinationFromContent(', start);
  if (start < 0 || end < 0) throw new Error('Could not extract normalizeBlbDestinationUrl from extension/content.js');
  const context = { URL };
  vm.runInNewContext(contentScript.slice(start, end), context);
  return context.normalizeBlbDestinationUrl;
}

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
    URL,
    injected,
    isHttpPageUrl: url => /^https?:\/\//i.test(String(url || '')),
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
    } else if (name === 'shouldInjectContentScriptForTab') {
      snippets.push(extractFunction(name, '\nchrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {'));
    } else {
      snippets.push(extractFunction(name, '\nchrome.permissions?.onAdded'));
    }
  }
  vm.runInNewContext(snippets.join('\n\n'), context);
  return { context, injected };
}

test.describe('ScriptTagger legacy BLB destination URLs', () => {
  test('accepts legacy .com links and canonicalizes them to HTTPS .org', () => {
    const normalize = runBlbUrlNormalizer();
    expect(normalize('https://www.blueletterbible.com/romans/3/23')).toBe('https://www.blueletterbible.org/romans/3/23');
    expect(normalize('http://www.blueletterbible.com/romans/3/23?x=1')).toBe('https://www.blueletterbible.org/romans/3/23?x=1');
    expect(normalize('https://www.blueletterbible.org/romans/3/23')).toBe('https://www.blueletterbible.org/romans/3/23');
    expect(normalize('https://example.com/romans/3/23')).toBe('');
  });
});

test.describe('global ScriptTagger content-script injection', () => {
  test('wildcard host grant activates an already-open unlisted website', async () => {
    const { context, injected } = runInjectionHelper(['injectEnabledTabsForGrantedOrigins'], {
      settings: { redirectEnabled: true, pageSelectionButtonSites: {}, doubleClickBlbSites: {} },
      tabs: [{ id: 42, url: 'https://sagacityweb.com/bible-reftagger-activated-for-sagacityweb/', hostAccess: true }]
    });

    await context.injectEnabledTabsForGrantedOrigins(['http://*/*', 'https://*/*']);
    expect(injected).toEqual([42]);
  });


  test('newly loaded unlisted website receives redirect handler when global redirect and host access are enabled', async () => {
    const { context } = runInjectionHelper(['shouldInjectContentScriptForTab'], {
      settings: { redirectEnabled: true, pageSelectionButtonSites: {}, doubleClickBlbSites: {} },
      tabs: []
    });

    const tab = {
      id: 51,
      url: 'https://sagacityweb.com/bible-reftagger-activated-for-sagacityweb/',
      hostAccess: true
    };
    const settings = {
      redirectEnabled: true,
      pageSelectionButtonSites: {},
      doubleClickBlbSites: {}
    };

    expect(await context.shouldInjectContentScriptForTab(tab, settings)).toBe(true);
    expect(await context.shouldInjectContentScriptForTab(
      { ...tab, hostAccess: false },
      settings
    )).toBe(false);
    expect(await context.shouldInjectContentScriptForTab(
      tab,
      { ...settings, redirectEnabled: false }
    )).toBe(false);
    expect(await context.shouldInjectContentScriptForTab(
      tab,
      { ...settings, masterEnabled: false }
    )).toBe(false);
  });

  test('master OFF blocks global redirect injection even when host access remains granted', async () => {
    const { context, injected } = runInjectionHelper(['injectRedirectEnabledTabs'], {
      settings: { masterEnabled: false, redirectEnabled: true },
      tabs: [
        { id: 71, url: 'https://chrome.google.com/webstore/devconsole/register', hostAccess: true }
      ]
    });

    await context.injectRedirectEnabledTabs();
    expect(injected).toEqual([]);
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
