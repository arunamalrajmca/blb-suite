const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const background = fs.readFileSync(path.resolve(__dirname, '../../extension/background.js'), 'utf8');
const sharedRegexPatterns = fs.readFileSync(path.resolve(__dirname, '../../extension/regex-patterns.js'), 'utf8');
const scriptTaggerScript = fs.readFileSync(path.resolve(__dirname, '../../extension/redirect-scripttagger.js'), 'utf8');

function runBlbUrlNormalizer() {
  const start = scriptTaggerScript.indexOf('function normalizeBlbDestinationUrl(');
  const end = scriptTaggerScript.indexOf('\n  function isModifiedLinkActivation(', start);
  if (start < 0 || end < 0) throw new Error('Could not extract normalizeBlbDestinationUrl from extension/redirect-scripttagger.js');
  const context = { URL };
  vm.runInNewContext(scriptTaggerScript.slice(start, end), context);
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
    BLB_HOSTNAME: 'blueletterbible.org',
    isSensitiveSiteHostname: value => /(?:bank|banking|banker|credit.?union|financial|finance|hospital|health|healthcare|clinic|medical|patient|mychart|insurance|insurer|assurance|claims)/i.test(String(value || '')),
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

test('global redirect uses the minimal handlers on ordinary sites and the full bundle on supported Bible sites', () => {
  const start = background.indexOf('const BLB_CONTENT_SCRIPT_FILES = [');
  const end = background.indexOf('\nfunction isHttpPageUrl(', start);
  if (start < 0 || end < 0) throw new Error('Could not extract content script selection helpers');
  const context = {
    URL,
    BLB_HOSTNAME: 'blueletterbible.org',
    hostnameFromTabUrl: value => { try { return new URL(String(value || '')).hostname; } catch (_) { return ''; } },
    normalizeSiteHostname: value => String(value || '').toLowerCase().replace(/^www\./, '')
  };
  context.globalThis = context;
  vm.runInNewContext(sharedRegexPatterns, context);
  vm.runInNewContext(background.slice(start, end), context);
  // Rediscover and Sagacity use the existing full content bundle because it
  // contains the current-page MultiVerse collector. They still use dynamic,
  // optional host access rather than manifest-wide site permissions.
  expect(Array.from(context.contentScriptFilesForTab(
    {url:'https://sagacityweb.com/article'},
    {redirectEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{}}
  ))).toEqual([
    'regex-patterns.js','kjv-corpus-word-index.js','books.js','book-aliases.js','reference-core.js','kings-bible-collector.js','webster-collector.js','content.js','redirect-scripttagger.js','redirect-bibleref-ranges.js'
  ]);

  expect(Array.from(context.contentScriptFilesForTab(
    {url:'https://www.biblegateway.com/passage/?search=John+3%3A16'},
    {redirectEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{}}
  ))).toEqual([
    'regex-patterns.js','kjv-corpus-word-index.js','books.js','book-aliases.js','reference-core.js','kings-bible-collector.js','webster-collector.js','content.js','redirect-scripttagger.js','redirect-bibleref-ranges.js'
  ]);

  expect(Array.from(context.contentScriptFilesForTab(
    {url:'https://sagacityweb.com/article'},
    {redirectEnabled:false,pageSelectionButtonSites:{'sagacityweb.com':true},doubleClickBlbSites:{}}
  ))).toEqual(['regex-patterns.js','kjv-corpus-word-index.js','books.js','book-aliases.js','reference-core.js','kings-bible-collector.js','webster-collector.js','content.js']);
});

async function runMinimalScriptTaggerClick(settings, eventOverrides = {}) {
  const listeners = {};
  const messages = [];
  const context = {
    URL,
    chrome: {
      storage: {
        local: { get: async defaults => ({ ...defaults, ...settings }) },
        onChanged: { addListener: listener => { context.storageChanged = listener; } }
      },
      runtime: { sendMessage: async message => { messages.push(message); return {ok:true}; } }
    },
    document: { addEventListener: (type, listener) => { listeners[type] = listener; } }
  };
  context.globalThis = context;
  vm.runInNewContext(scriptTaggerScript, context);
  await new Promise(resolve => setTimeout(resolve, 0));
  const link = {
    href:'https://www.blueletterbible.com/kjv/jhn/3/16/',
    closest: selector => selector === 'a.BLBST_a[href]' ? link : null
  };
  const event = {
    button:0, metaKey:false, ctrlKey:false, shiftKey:false, altKey:false,
    target:{closest: selector => selector === 'a.BLBST_a[href]' ? link : null},
    prevented:false, stopped:false,
    preventDefault(){ this.prevented = true; },
    stopImmediatePropagation(){ this.stopped = true; },
    ...eventOverrides
  };
  listeners.click(event);
  await Promise.resolve();
  return { event, messages };
}

test('minimal ScriptTagger handler redirects only when master and global redirect are enabled', async () => {
  const enabled = await runMinimalScriptTaggerClick({masterEnabled:true,redirectEnabled:true});
  expect(enabled.event.prevented).toBe(true);
  expect(enabled.event.stopped).toBe(true);
  expect(enabled.messages).toEqual([{
    type:'blbSuiteOpenScriptTaggerUrl',
    url:'https://www.blueletterbible.org/kjv/jhn/3/16/',
    activeIfNew:true,
    activateExisting:true
  }]);

  const disabled = await runMinimalScriptTaggerClick({masterEnabled:true,redirectEnabled:false});
  expect(disabled.event.prevented).toBe(false);
  expect(disabled.messages).toEqual([]);

  const masterOff = await runMinimalScriptTaggerClick({masterEnabled:false,redirectEnabled:true});
  expect(masterOff.event.prevented).toBe(false);
  expect(masterOff.messages).toEqual([]);
});

test('ScriptTagger destination keys keep distinct verses separate and coalesce repeats', async () => {
  const start = background.indexOf('// ScriptTagger has a stricter destination identity');
  const end = background.indexOf('async function openBlbDestination(', start);
  if (start < 0 || end < 0) throw new Error('Could not extract ScriptTagger destination manager');

  const tabs = [];
  let nextId = 1;
  let queue = Promise.resolve();
  const chrome = {
    tabs: {
      query: async () => tabs,
      create: async options => {
        const tab = { id: nextId++, url: options.url, pendingUrl: options.url, windowId: 1, active: options.active };
        tabs.push(tab);
        return tab;
      },
      update: async (id, changes) => {
        const tab = tabs.find(item => item.id === id);
        if (tab) Object.assign(tab, changes);
        return tab;
      }
    },
    windows: { update: async () => ({ focused: true }) }
  };
  const context = {
    URL,
    URLSearchParams,
    Map,
    chrome,
    getLiveTabById: async id => tabs.find(tab => tab.id === id) || null,
    enqueueBlbTabCreation: operation => {
      const result = queue.then(operation, operation);
      queue = result.catch(() => {});
      return result;
    }
  };
  vm.runInNewContext(background.slice(start, end), context);

  const first = await context.openScriptTaggerDestination('https://www.blueletterbible.org/kjv/jhn/3/16/');
  const second = await context.openScriptTaggerDestination('https://www.blueletterbible.org/kjv/jhn/3/17/');
  const firstAgain = await context.openScriptTaggerDestination('https://www.blueletterbible.org/kjv/jhn/3/16/');
  expect(first.id).not.toBe(second.id);
  expect(firstAgain.id).toBe(first.id);
  expect(tabs).toHaveLength(2);

  const concurrent = await Promise.all([
    context.openScriptTaggerDestination('https://www.blueletterbible.org/kjv/rom/8/28/'),
    context.openScriptTaggerDestination('https://www.blueletterbible.org/kjv/rom/8/28/')
  ]);
  expect(concurrent[0].id).toBe(concurrent[1].id);
  expect(tabs).toHaveLength(3);
});
