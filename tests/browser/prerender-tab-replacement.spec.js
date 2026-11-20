const { test, expect } = require('./fixtures');
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(read, description, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('native Chromium prerender activation emits tabs.onReplaced without a DevTools connection', async ({
  extensionPath
}) => {
  test.setTimeout(120000);
  const events = [];
  const prerenderRequests = [];
  let destination = '';
  let origin = '';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/event') {
      events.push(Object.fromEntries(url.searchParams.entries()));
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/source') {
      const rules = {
        prerender:[{
          source:'list',
          urls:[destination],
          eagerness:'immediate'
        }]
      };
      response.writeHead(200, {
        'Content-Type':'text/html; charset=utf-8',
        'Cache-Control':'public, max-age=60'
      });
      response.end(`<!doctype html>
<html><head><title>BLB prerender source</title>
<script type="speculationrules">${JSON.stringify(rules)}</script>
<style>body{font:24px Arial}#activate{position:fixed;left:24px;top:24px;padding:24px;background:#ffe88a;color:#111;border:3px solid #333}</style>
</head><body><a id="activate" href="${destination}">Activate prerendered destination</a></body></html>`);
      return;
    }
    if (url.pathname === '/destination') {
      const secPurpose = request.headers['sec-purpose'] || '';
      if (secPurpose.includes('prerender')) {
        const record = {
          url:request.url,
          secPurpose,
          responseFinished:false
        };
        prerenderRequests.push(record);
        response.once('finish', () => { record.responseFinished = true; });
      }
      response.writeHead(200, {
        'Content-Type':'text/html; charset=utf-8',
        'Cache-Control':'public, max-age=60'
      });
      response.end('<!doctype html><html><head><title>BLB prerender destination</title></head><body>Prerender destination</body></html>');
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  destination = `${origin}/destination?run=native-prerender`;

  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([
    ...(manifest.host_permissions || []),
    'http://127.0.0.1/*'
  ])];
  manifest.content_scripts = manifest.content_scripts || [];
  manifest.content_scripts.push({
    matches:['http://127.0.0.1/*'],
    js:['prerender-test-observer.js'],
    run_at:'document_idle'
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const observerScript = `
(() => {
  const report = () => {
    if (document.prerendering) {
      document.addEventListener('prerenderingchange', report, { once:true });
      return;
    }
    let attempts = 0;
    const send = () => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const payload = {
        type:'content-ready',
        url:location.href,
        activationStart:navigation?.activationStart || 0,
        fileExecuted:!!globalThis.__blbSuiteContentScriptFileExecutedV3,
        initialized:!!globalThis.__blbSuiteContentScriptLoadedV2,
        doubleClickBound:!!globalThis.__blbSuiteDoubleClickBoundV2
      };
      if ((!payload.fileExecuted || !payload.initialized) && attempts++ < 50) {
        setTimeout(send, 100);
        return;
      }
      const query = new URLSearchParams(payload);
      new Image().src = 'http://127.0.0.1:__PORT__/event?' + query.toString();
    };
    send();
  };
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', report, { once:true });
  } else {
    report();
  }
})();
`.replace('__PORT__', String(server.address().port));
  fs.writeFileSync(path.join(extensionPath, 'prerender-test-observer.js'), observerScript);

  const backgroundPath = path.join(extensionPath, 'background.js');
  const testPort = server.address().port;
  const backgroundObserver = `

// Test-only observer appended to the temporary extension copy. This code is
// absent from the repository extension and reports through HTTP so the test
// does not need to attach DevTools to Chromium.
const __blbPrerenderTestPort = ${testPort};
const __blbPrerenderTestSettings = {
  masterEnabled:true,
  redirectEnabled:false,
  pageSelectionButtonSites:{'127.0.0.1':true},
  doubleClickBlbSites:{'127.0.0.1':true}
};
async function __blbPrerenderTestReport(values) {
  const query = new URLSearchParams(values);
  try {
    await fetch('http://127.0.0.1:' + __blbPrerenderTestPort + '/event?' + query.toString(), {
      cache:'no-store'
    });
  } catch (_) {}
}
async function __blbPrerenderTestInitialize() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { masterEnabled } = await chrome.storage.local.get({masterEnabled:null});
    if (masterEnabled !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await chrome.storage.local.set(__blbPrerenderTestSettings);
  if (typeof reconcileRuntimeContentScriptRegistrations === 'function') {
    await reconcileRuntimeContentScriptRegistrations().catch(() => {});
  }
  const sourceTabs = await chrome.tabs.query({url:'http://127.0.0.1/*'});
  for (const tab of sourceTabs) {
    if (tab.url && new URL(tab.url).pathname === '/source') {
      await __blbPrerenderTestReport({
        type:'source-tab', id:tab.id, url:tab.url, active:tab.active
      });
    }
  }
  await __blbPrerenderTestReport({type:'extension-ready'});
}
chrome.runtime.onInstalled.addListener(() => {
  __blbPrerenderTestInitialize().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  __blbPrerenderTestInitialize().catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && new URL(tab.url).pathname === '/source') {
    __blbPrerenderTestReport({
      type:'source-tab',
      id:tabId,
      url:tab.url,
      active:tab.active
    });
  }
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  chrome.tabs.get(addedTabId).then(tab => {
    __blbPrerenderTestReport({
      type:'tab-replaced',
      addedTabId,
      removedTabId,
      url:tab.url
    });
  }).catch(() => {
    __blbPrerenderTestReport({type:'tab-replaced',addedTabId,removedTabId,url:''});
  });
});
`;
  fs.appendFileSync(backgroundPath, backgroundObserver);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-native-prerender-profile-'));
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive:true });
  fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify({
    net:{network_prediction_options:0}
  }));

  const chromePath = chromium.executablePath();
  const chrome = spawn(chromePath, [
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    '--window-position=0,0',
    '--enable-features=Prerender2',
    '--disable-features=PreloadingHoldback,Prerender2Holdback',
    `${origin}/source`
  ], { stdio:['ignore','ignore','pipe'], env:process.env });

  let chromeStderr = '';
  chrome.stderr.on('data', chunk => {
    chromeStderr = (chromeStderr + chunk.toString()).slice(-12000);
  });

  try {
    await waitFor(() => events.find(event => event.type === 'extension-ready'),
      'the unpacked extension service worker to initialize its test settings');
    const sourceTab = await waitFor(() => events.find(event => event.type === 'source-tab'),
      'the source page to become the active browser tab');
    expect(sourceTab.active).toBe('true');

    await waitFor(() => prerenderRequests.find(request => request.responseFinished),
      'the destination response requested with Sec-Purpose: prefetch;prerender');
    await delay(2500);

    const windowId = await waitFor(() => {
      try {
        return execFileSync('xdotool', [
          'search','--onlyvisible','--name','BLB prerender source'
        ], {encoding:'utf8'}).trim().split('\n')[0];
      } catch (_) {
        return null;
      }
    }, 'the visible native Chromium source window');
    execFileSync('xdotool', ['windowfocus','--sync',windowId]);
    execFileSync('xdotool', ['mousemove','--window',windowId,'180','150','click','1']);

    const replacement = await waitFor(() =>
      events.find(event => event.type === 'tab-replaced'),
    'the real chrome.tabs.onReplaced event from the extension service worker', 20000);
    expect(Number(replacement.addedTabId)).not.toBe(Number(replacement.removedTabId));
    expect(replacement.url).toBe(destination);

    const destinationReady = await waitFor(() =>
      events.find(event => event.type === 'content-ready' && event.url === destination),
    'the activated destination document and extension content-script readiness', 15000);
    expect(Number(destinationReady.activationStart)).toBeGreaterThan(0);
    expect(destinationReady.fileExecuted).toBe('true');
    expect(destinationReady.initialized).toBe('true');
    expect(destinationReady.doubleClickBound).toBe('true');
  } catch (error) {
    throw new Error([
      error.message,
      'Prerender requests: ' + JSON.stringify(prerenderRequests),
      'Observed extension events: ' + JSON.stringify(events),
      'Chromium stderr: ' + chromeStderr.slice(-6000)
    ].join('\n\n'));
  } finally {
    chrome.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => chrome.once('exit', resolve)),
      delay(5000)
    ]);
    if (chrome.exitCode === null && !chrome.killed) chrome.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(userDataDir, {recursive:true,force:true});
  }
});
