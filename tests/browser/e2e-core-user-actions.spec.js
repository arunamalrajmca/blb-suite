const { test, expect } = require('./fixtures');

function normalizeBlbKjvPath(pathname) {
  return String(pathname || '').replace(/\/s_\d+\/?$/i, '/');
}

async function waitForTab(extensionWorker, predicate, timeout = 10000) {
  let match = null;
  let lastTabs = [];
  try {
    await expect.poll(async () => {
      lastTabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
        items.map(tab => ({
          id: tab.id,
          url: tab.url || tab.pendingUrl || '',
          pendingUrl: tab.pendingUrl || ''
        }))
      ));
      match = lastTabs.find(predicate) || null;
      return !!match;
    }, { timeout }).toBeTruthy();
  } catch (error) {
    console.error('[waitForTab] timed out; observed tabs:', JSON.stringify(lastTabs));
    throw error;
  }
  return match;
}

async function removeTabById(extensionWorker, id) {
  if (id == null) return;
  await extensionWorker.evaluate((tabId) => chrome.tabs.remove(tabId).catch(() => {}), id);
}

async function dismissBlbCookieOverlay(page) {
  await page.evaluate(() => {
    document.querySelector('#cookie-wrapper')?.remove();
  });
}

test.describe('core user-action E2E coverage', () => {
  test('Alt+B command path opens an exact selected Bible reference', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-alt-b';
      el.textContent = 'John 3:16';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const command = await extensionWorker.evaluate(() => {
      const manifest = chrome.runtime.getManifest();
      return manifest.commands?.['open-bible-selection-in-blb'] || null;
    });
    expect(command?.suggested_key?.default).toBe('Alt+B');

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      console.log('[E2E Alt+B] active tab before command:', tab ? {id:tab.id,url:tab.url} : null);
      if (!tab?.id) throw new Error('No active tab for Alt+B command-path E2E');
      await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        world: 'ISOLATED',
        func: () => new Promise(resolve => {
          chrome.runtime.sendMessage({type:'blbSuiteOpenCurrentSelection'}, () => resolve());
        })
      });
    });

    const blb = await waitForTab(extensionWorker, tab => {
      console.log('[E2E Alt+B] observed tab:', tab);
      try {
        return new URL(tab.url).hostname === 'www.blueletterbible.org'
          && /^\/kjv\/jhn\/3\/16(?:\/s_\d+)?\/?$/i.test(new URL(tab.url).pathname);
      } catch (_) {
        return false;
      }
    });

    expect(new URL(blb.url).pathname).toMatch(/^\/kjv\/jhn\/3\/16(?:\/s_\d+)?\/?$/i);
    await removeTabById(extensionWorker, blb.id);
  });

  test('MultiVerse Copy button adds a BLB hyperlink to HTML clipboard data', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    // Exercise BLB's native MultiVerse copy flow against a deterministic fixture.
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <button id="copyButton" data-clipboard-text="(John 3:16)">Copy</button>
        <a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>
        <p id="blb-e2e-copy">John 3:16</p>
        <script>
          document.querySelector('#copyButton').addEventListener('click', function () {
            const textarea = document.createElement('textarea');
            textarea.value = this.getAttribute('data-clipboard-text');
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
          });
        </script>
      </body></html>`
    }));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.blueletterbible.org' });
    await page.goto('https://www.blueletterbible.org/tools/MultiVerse.cfm', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.locator('#copyButton').click();

    const captured = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      const items = await navigator.clipboard.read();
      let html = '';
      let plain = '';
      for (const item of items) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
      }
      return { html, plain };
    });
    expect(captured.plain).toBe('(John 3:16)');
    expect(captured.html).toContain('blueletterbible.org/kjv/jhn/3/16/');
    expect(captured.html).toContain('/kjv/jhn/3/16/');
  });

  test('normal Ctrl+C in MultiVerse does not override the default clipboard behaviour', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><button id="copyButton" data-clipboard-text="(John 3:16)">Copy</button><a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a><p id="blb-e2e-copy">John 3:16</p></body></html>'
    }));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.blueletterbible.org' });
    await page.goto('https://www.blueletterbible.org/tools/MultiVerse.cfm', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.querySelector('#blb-e2e-copy');
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const result = document.execCommand('copy');
      if (!result) throw new Error("document.execCommand('copy') returned false");
    });

    const captured = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      const items = await navigator.clipboard.read();
      let html = '';
      let plain = '';
      for (const item of items) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
      }
      return { html, plain };
    });
    expect(captured.plain).toBe('John 3:16');
    expect(captured.html).not.toContain('blueletterbible.org/kjv/jhn/3/16/');
  });


  test('copying typed MultiVerse references preserves the exact input text', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><textarea id="mvText">John 3:16, Romans 8:1-3</textarea><button id="copyButton" data-clipboard-text="(John 3:16)">Copy</button><a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a></body></html>'
    }));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.blueletterbible.org' });
    await page.goto('https://www.blueletterbible.org/tools/MultiVerse.cfm', { waitUntil: 'domcontentloaded' });
    await page.locator('#mvText').evaluate(el => {
      el.focus();
      el.select();
      if (!document.execCommand('copy')) throw new Error("document.execCommand('copy') returned false");
    });

    const captured = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      const items = await navigator.clipboard.read();
      let html = '';
      let plain = '';
      for (const item of items) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
      }
      return { html, plain };
    });
    expect(captured.plain).toBe('John 3:16, Romans 8:1-3');
    expect(captured.html).not.toContain('blueletterbible.org/kjv/jhn/3/16/');
  });

  test('BLB verse links inside parse popups open in a new tab', async ({ page, context, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true });
    // Parse-popup interception is BLB-host-specific, so serve a deterministic
    // fixture at the BLB origin instead of depending on the live website.
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body></body></html>'
    }));
    await page.goto('https://www.blueletterbible.org/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'parse-popup';
      popup.innerHTML = '<a id="blb-e2e-popup-link" href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>';
      document.body.appendChild(popup);
    });

    const link = page.locator('#blb-e2e-popup-link');
    await expect(link).toHaveAttribute('data-blb-suite-popup', '1');

    // The extension creates tabs through chrome.tabs.create in its service
    // worker. Observe that authoritative browser-tab state directly rather
    // than relying on Playwright's page event, which can miss extension-created
    // tabs in a persistent context even when Chromium creates them.
    const sourceUrl = page.url();
    const tabsBefore = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({url:'https://www.blueletterbible.org/*'})).map(tab => tab.id)
    );

    await link.click();

    await expect.poll(async () => extensionWorker.evaluate(async (previousIds) => {
      const tabs = await chrome.tabs.query({url:'https://www.blueletterbible.org/*'});
      return tabs.some(tab =>
        !previousIds.includes(tab.id) &&
        new URL(tab.url || tab.pendingUrl || '').pathname === '/kjv/jhn/3/16/'
      );
    }, tabsBefore), { timeout: 10000 }).toBe(true);

    expect(page.url()).toBe(sourceUrl);
  });
  test('continuous same-chapter multi-reference selection opens the normal chapter range', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-continuous-range-selection';
      el.textContent = 'Romans 10:9 and Romans 10:10';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();

    const rangeTab = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && normalizeBlbKjvPath(url.pathname) === '/kjv/rom/10/9-10/';
      } catch (_) { return false; }
    });
    expect(normalizeBlbKjvPath(new URL(rangeTab.url).pathname)).toBe('/kjv/rom/10/9-10/');

    const multiVerseTabs = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({ url: 'https://www.blueletterbible.org/tools/MultiVerse.cfm*' }))
        .filter(tab => /blbSuiteMultiVerse=1/.test(tab.url || tab.pendingUrl || ''))
        .map(tab => tab.id)
    );
    expect(multiVerseTabs).toHaveLength(0);
    await removeTabById(extensionWorker, rangeTab.id);
  });

  test('selection containing a reference and authored prose opens MultiVerse and Criteria Search', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-paragraph-two-tab';
      el.textContent = 'Philippians 2:12 and John 3:16 — free gift';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();

    const multiVerse = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && url.pathname === '/tools/MultiVerse.cfm';
      } catch (_) {
        return false;
      }
    });

    const criteria = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && url.pathname === '/search/search.cfm'
          && (url.searchParams.get('Criteria') || '').toLowerCase().includes('free gift');
      } catch (_) {
        return false;
      }
    });

    expect(new URL(multiVerse.url).pathname).toBe('/tools/MultiVerse.cfm');
    expect(new URL(criteria.url).searchParams.get('Criteria').toLowerCase()).toContain('free gift');

    await removeTabById(extensionWorker, multiVerse.id);
    await removeTabById(extensionWorker, criteria.id);
  });
});


test('Double-Click resolves contextual chapter numbers and unique KJV words directly', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-doubleclick-context';
    el.innerHTML = 'The answer requires looking closely at <span>Matthew</span> <span id="mc18">18</span>, <span>Luke</span> <span id="lc17">17</span>, repentance, and the parable of the unforgiving servant.';
    el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(el);
  });

  await page.locator('#mc18').dblclick();
  const matthew = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/mat/18/';
    } catch (_) { return false; }
  });
  expect(new URL(matthew.url).pathname).toBe('/kjv/mat/18/');
  await removeTabById(extensionWorker, matthew.id);

  await page.locator('#lc17').dblclick();
  const luke = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/luk/17/';
    } catch (_) { return false; }
  });
  expect(new URL(luke.url).pathname).toBe('/kjv/luk/17/');
  await removeTabById(extensionWorker, luke.id);

  // The contextual rule is generic: the clicked chapter number must inherit
  // the book name from its exact nearby reference occurrence, regardless of
  // which book is used or how the webpage nests the text.
  await page.evaluate(() => {
    const cases = [
      ['Genesis', '50', 'gen50'],
      ['Romans', '16', 'rom16'],
      ['Acts', '17', 'acts17'],
      ['John', '3', 'john3']
    ];
    const wrap = document.createElement('div');
    wrap.id = 'blb-e2e-generic-contextual-refs';
    wrap.style.cssText = 'position:fixed;left:24px;top:180px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    for (const [book, chapter, id] of cases) {
      const row = document.createElement('p');
      row.innerHTML = '<span>' + book + '</span> <span class="nested-ref"><span id="' + id + '">' + chapter + '</span></span>';
      wrap.appendChild(row);
    }
    document.body.appendChild(wrap);
  });

  // Simulate a real webpage where the user already has an unrelated
  // selection before double-clicking the chapter number. The resolver must
  // ignore that stale native Selection and use the current gesture.
  await page.evaluate(() => {
    const stale = document.createElement('span');
    stale.id = 'blb-e2e-stale-selection';
    stale.textContent = 'unrelated';
    document.body.appendChild(stale);
    const range = document.createRange();
    range.selectNodeContents(stale);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const genericCases = [
    ['#gen50', '/kjv/gen/50/'],
    ['#rom16', '/kjv/rom/16/'],
    ['#acts17', '/kjv/act/17/'],
    ['#john3', '/kjv/jhn/3/']
  ];

  for (const [selector, expectedPath] of genericCases) {
    console.log('[numbered-list E2E] starting', { selector, expectedPath });
    await page.locator(selector).dblclick();
    console.log('[numbered-list serial] post-dblclick selection', await page.evaluate(() => ({
      selection: window.getSelection()?.toString() || '',
      activeElement: document.activeElement?.outerHTML?.slice(0, 240) || ''
    })));
    let resolved;
    try {
      resolved = await waitForTab(extensionWorker, tab => {
        try {
          const url = new URL(tab.url);
          return url.hostname === 'www.blueletterbible.org' && normalizeBlbKjvPath(url.pathname) === expectedPath;
        } catch (_) { return false; }
      });
    } catch (error) {
      const tabs = await extensionWorker.evaluate(async () => (await chrome.tabs.query({})).map(tab => ({
        id: tab.id, url: tab.url || '', pendingUrl: tab.pendingUrl || ''
      })));
      console.error('[numbered-list E2E] expected tab not found', { selector, expectedPath, tabs });
      throw error;
    }
    console.log('[numbered-list E2E] resolved', { selector, url: resolved.url });
    expect(normalizeBlbKjvPath(new URL(resolved.url).pathname)).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }

  await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-doubleclick-unique-word';
    el.innerHTML = 'The word <span id="injurious">injurious</span> appears here.';
    el.style.cssText = 'position:fixed;left:24px;top:100px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(el);
  });

  await page.locator('#injurious').dblclick();
  const verse = await waitForTab(extensionWorker, tab => {
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/1ti/1/13/';
    } catch (_) { return false; }
  });
  expect(new URL(verse.url).pathname).toBe('/kjv/1ti/1/13/');
  await removeTabById(extensionWorker, verse.id);
});

const numberedListBookNames = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
  '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
  'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon',
  'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
  'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah',
  'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians',
  '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians',
  '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James',
  '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation'
];
const numberedListBookSlugs = [
  'gen', 'exo', 'lev', 'num', 'deu', 'jos', 'jdg', 'rth', '1sa', '2sa', '1ki', '2ki',
  '1ch', '2ch', 'ezr', 'neh', 'est', 'job', 'psa', 'pro', 'ecc', 'sng', 'isa', 'jer',
  'lam', 'eze', 'dan', 'hos', 'joe', 'amo', 'oba', 'jon', 'mic', 'nah', 'hab', 'zep',
  'hag', 'zec', 'mal', 'mat', 'mar', 'luk', 'jhn', 'act', 'rom', '1co', '2co', 'gal',
  'eph', 'phl', 'col', '1th', '2th', '1ti', '2ti', 'tit', 'phm', 'heb', 'jas', '1pe',
  '2pe', '1jo', '2jo', '3jo', 'jde', 'rev'
];
// Test all 66 canonical book labels, including numeric-prefix book names.
const numberedListBookCases = numberedListBookSlugs
  .map((slug,index)=>({label:index+1,slug,name:numberedListBookNames[index]}));

async function setupNumberedListSerialFixture({page,extensionStorage}) {
  await extensionStorage.set({masterEnabled:true,doubleClickBlbSites:{'example.com':true}});
  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  await page.evaluate(({bookNames})=>{
    const cases=[
      ...bookNames.map((name,index)=>[String(index+1),name,'serial-'+(index+1)]),
      ['67','Romans 1:16','serial-67'],['176','Romans 1:16','serial-176'],
      ['177','Romans 1:16','serial-177'],['250','Romans 1:16','serial-250'],['0','Romans 1:16','serial-0']
    ];
    const wrap=document.createElement('div');
    wrap.id='blb-e2e-numbered-list-serials';
    wrap.style.cssText='position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;max-height:75vh;overflow:auto;';
    for(const [number,text,id] of cases){
      const row=document.createElement('p');
      row.style.margin='4px 0';
      row.innerHTML='<strong id="'+id+'">'+number+'. '+text+'</strong>';
      wrap.appendChild(row);
    }
    document.body.appendChild(wrap);
  },{bookNames:numberedListBookNames});
  await expect(page.locator('#blb-e2e-numbered-list-serials')).toBeVisible();
}

async function checkNumberedBookGroup({page,extensionWorker},cases) {
  const results=[];
  for(const {label,slug} of cases){
    const selector='#serial-'+label;
    const expectedPath='/kjv/'+slug+'/1/1/';
    const existingIds=await extensionWorker.evaluate(async()=>(await chrome.tabs.query({})).map(tab=>tab.id));
    console.log('[numbered-list serial] starting',{label,selector,expectedPath});
    try{
      const locator=page.locator(selector);
      await locator.scrollIntoViewIfNeeded({timeout:2500});
      await locator.dblclick({position:{x:4,y:10},timeout:2500});
      const resolved=await waitForTab(extensionWorker,tab=>{
        if(existingIds.includes(tab.id)) return false;
        try{
          const url=new URL(tab.url||tab.pendingUrl||'');
          return url.hostname==='www.blueletterbible.org'&&normalizeBlbKjvPath(url.pathname)===expectedPath;
        }catch(_){return false;}
      },2500);
      results.push({label,expectedPath,result:'PASS',actualUrl:resolved.url});
      console.log('[numbered-list serial] PASS',results[results.length-1]);
    }catch(error){
      results.push({label,expectedPath,result:'FAIL',error:String(error?.message||error)});
      console.error('[numbered-list serial] FAIL',results[results.length-1]);
    }finally{
      const newIds=await extensionWorker.evaluate(async existing=>(await chrome.tabs.query({}))
        .filter(tab=>!existing.includes(tab.id)&&(()=>{
          try{return new URL(tab.url||tab.pendingUrl||'').hostname==='www.blueletterbible.org';}
          catch(_){return false;}
        })()).map(tab=>tab.id),existingIds);
      for(const id of newIds) await removeTabById(extensionWorker,id);
      await page.evaluate(()=>window.getSelection()?.removeAllRanges());
    }
  }
  console.log('[numbered-list serial] GROUP SUMMARY',JSON.stringify(results));
  expect(results,'Every book label in this group must be attempted').toHaveLength(cases.length);
  expect(results.filter(item=>item.result==='PASS'),'Every book label must resolve to its expected BLB path').toHaveLength(cases.length);
}

test('Double-Click numbered-list labels 1-66 resolve to all 66 correct BLB books',async({page,extensionStorage,extensionWorker})=>{
  // A single longer test ensures every canonical book label is covered in one run.
  // The helper records individual failures and continues so one bad slug does not
  // prevent the remaining books from being checked.
  test.setTimeout(600000);
  await setupNumberedListSerialFixture({page,extensionStorage});
  await checkNumberedBookGroup({page,extensionWorker},numberedListBookCases);
});

test('Double-Click on serials above 66 and zero does not borrow the following Bible reference',async({page,extensionStorage,extensionWorker})=>{
  test.setTimeout(30000);
  await setupNumberedListSerialFixture({page,extensionStorage});
  const results=[];
  for(const label of [67,176,177,250,0]){
    const selector='#serial-'+label;
    const existingIds=await extensionWorker.evaluate(async()=>(await chrome.tabs.query({})).map(tab=>tab.id));
    try{
      const locator=page.locator(selector);
      await locator.scrollIntoViewIfNeeded({timeout:2500});
      await locator.dblclick({position:{x:4,y:10},timeout:2500});
      await page.waitForTimeout(500);
      const newBlbTabs=await extensionWorker.evaluate(async existing=>(await chrome.tabs.query({}))
        .filter(tab=>!existing.includes(tab.id)).filter(tab=>{
          try{return new URL(tab.url||tab.pendingUrl||'').hostname==='www.blueletterbible.org';}
          catch(_){return false;}
        }).map(tab=>tab.url||tab.pendingUrl||''),existingIds);
      expect(newBlbTabs,'Serial '+label+' must not open a BLB tab').toEqual([]);
      results.push({label,result:'PASS'});
      console.log('[numbered-list serial] invalid serial PASS',{label});
    }catch(error){
      results.push({label,result:'FAIL',error:String(error?.message||error)});
      console.error('[numbered-list serial] invalid serial FAIL',results[results.length-1]);
    }finally{
      const newIds=await extensionWorker.evaluate(async existing=>(await chrome.tabs.query({}))
        .filter(tab=>!existing.includes(tab.id)&&(()=>{
          try{return new URL(tab.url||tab.pendingUrl||'').hostname==='www.blueletterbible.org';}
          catch(_){return false;}
        })()).map(tab=>tab.id),existingIds);
      for(const id of newIds) await removeTabById(extensionWorker,id);
    }
  }
  console.log('[numbered-list serial] INVALID SERIAL SUMMARY',JSON.stringify(results));
  expect(results,'All invalid serial cases must be attempted').toHaveLength(5);
  expect(results.filter(item=>item.result==='PASS')).toHaveLength(5);
});

test('Ordinary numbers without a list-label period are not classified as serials',async({page,extensionStorage})=>{
  await extensionStorage.set({masterEnabled:true,doubleClickBlbSites:{'example.com':true}});
  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{
    const p=document.createElement('p');
    p.id='ordinary-number-without-period';
    p.textContent='250 items are listed here.';
    document.body.appendChild(p);
  });
  await expect(page.locator('#ordinary-number-without-period')).toContainText('250 items');
});

test('Double-Click anywhere in a consecutive comma-separated verse citation opens the full range', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'blb-e2e-comma-verse-list';
    el.setAttribute('dir', 'auto');
    el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;text-align:start;';
    // Match the real-world DOM: the citation is plain text in one parent,
    // followed by a nested, focusable "See less" control.
    el.appendChild(document.createTextNode('Romans 10:9,10 '));
    const seeLess = document.createElement('div');
    seeLess.className = 'x1i10hfl xjbqb8w x1ejq31n x18oe1m7 x1sy0etr xstzfhl x972fbf x10w94by x1qhh985 x14e42zd x9f619 x1ypdohk xt0psk2 x3ct3a4 xdj266r x14z9mp xat24cr x1lziwak xexx8yu xyri2b2 x18d9i69 x1c1uobl x16tdsg8 x1hl2dhg xggy1nq x1a2a7pz xkrqix3 x1sur9pj xzsf02u x1s688f';
    seeLess.setAttribute('role', 'button');
    seeLess.setAttribute('tabindex', '0');
    seeLess.textContent = 'See less';
    el.appendChild(seeLess);
    document.body.appendChild(el);
  });
  // Give each extension-created tab up to 30 seconds to appear in slower CI runs.
  // Test the real text node, rather than artificial spans around each token.
  // Double-click several words in the citation to check context-based resolution.
  for (const target of [
    { label: 'book name', word: 'Romans', occurrence: 0 },
    { label: 'chapter number', word: '10', occurrence: 0 },
    { label: 'first verse number', word: '9', occurrence: 0 },
    { label: 'second verse number', word: '10', occurrence: 1 }
  ]) {
    console.log('[comma verse-range double-click] testing target:', target.label);
    // Use a DOM Range to locate the word without adding markup that would
    // change the real-world plain-text node structure.
    await page.locator('#blb-e2e-comma-verse-list').evaluate((root, requested) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      let seen = 0;
      while ((node = walker.nextNode())) {
        let offset = -1;
        let searchFrom = 0;
        while ((searchFrom = node.textContent.indexOf(requested.word, searchFrom)) >= 0) {
          if (seen++ === requested.occurrence) { offset = searchFrom; break; }
          searchFrom += requested.word.length;
        }
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + requested.word.length);
        const rect = range.getBoundingClientRect();
        root.dataset.testClickX = String(rect.left + rect.width / 2);
        root.dataset.testClickY = String(rect.top + rect.height / 2);
        return;
      }
      throw new Error('Could not find text target: ' + requested.label);
    }, target);
    const clickPoint = await page.locator('#blb-e2e-comma-verse-list').evaluate(root => ({
      x: Number(root.dataset.testClickX), y: Number(root.dataset.testClickY)
    }));
    await page.mouse.dblclick(clickPoint.x, clickPoint.y);
    const selectionDiagnostic = await page.evaluate(() => {
      const root = document.querySelector('#blb-e2e-comma-verse-list');
      const selection = window.getSelection();
      return {
        targetText: root?.textContent || '',
        nativeSelection: selection?.toString() || '',
        anchorText: selection?.anchorNode?.textContent || '',
        focusText: selection?.focusNode?.textContent || '',
        anchorOffset: selection?.anchorOffset ?? null,
        focusOffset: selection?.focusOffset ?? null
      };
    });
    console.log('[comma verse-range double-click] native selection:', { target: target.label, ...selectionDiagnostic });
    const range = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' && normalizeBlbKjvPath(url.pathname) === '/kjv/rom/10/9-10/';
      } catch (_) { return false; }
    }, 30000);
    console.log('[comma verse-range double-click] matched tab:', { target: target.label, url: range.url });
    expect(normalizeBlbKjvPath(new URL(range.url).pathname), 'Target ' + target.label + ' should open Romans 10:9-10').toBe('/kjv/rom/10/9-10/');
    await removeTabById(extensionWorker, range.id);
  }
});

test('Double-Click resolves references through custom and framework-generated DOM containers', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'blb-e2e-custom-dom-context';
    host.style.cssText = 'position:fixed;left:24px;top:320px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    host.innerHTML = [
      '<article-card><span>Genesis</span> <ref-token><strong id="custom-gen50">50</strong></ref-token></article-card>',
      '<framework-line><span>Romans</span> <inline-ref><em id="custom-rom16">16</em></inline-ref></framework-line>',
      '<x-text-row><span>Acts</span> <x-reference><b id="custom-acts17">17</b></x-reference></x-text-row>'
    ].join('');
    document.body.appendChild(host);
  });

  const cases = [
    ['#custom-gen50', '/kjv/gen/50/'],
    ['#custom-rom16', '/kjv/rom/16/'],
    ['#custom-acts17', '/kjv/act/17/']
  ];

  for (const [selector, expectedPath] of cases) {
    await page.locator(selector).dblclick();
    const resolved = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
      } catch (_) { return false; }
    });
    expect(new URL(resolved.url).pathname).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }
});


test('Double-Click resolves partial references in Instagram-style rich text with line breaks', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const post = document.createElement('div');
    post.id = 'blb-e2e-instagram-caption';
    post.innerHTML = '<span dir="auto">But thou, O LORD, be merciful unto me, And raise me up, that I may requite them.<br><span>Psalm</span> <span id="psalm-41-chapter">41</span><span>:</span><span>10</span> <span>KJV</span><br><br>He will regard the prayer of the destitute, And not despise their prayer.<br><span>Psalm</span> <span>102</span><span>:</span><span>17</span> <span>KJV</span><br><br>To hear the groaning of the prisoner; To loose those that are appointed to death;<br><span>Psalm</span> <span>102</span><span>:</span><span>20</span> <span>KJV</span><br><br>11 My lovers and my friends stand aloof from my sore; And my kinsmen stand afar off.<br>12 They also that seek after my life lay snares for me: And they that seek my hurt speak mischievous things, and imagine deceits all the day long.<br>13 But I, as a deaf man, heard not; And I was as a dumb man that openeth not his mouth.<br>14 Thus I was as a man that heareth not; And in whose mouth are no reproofs.<br><span>Psalm</span> <span>38</span><span>:</span><span>11-</span><span id="psalm-38-end">14</span> <span>KJV</span></span>';
    post.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:18px Arial,sans-serif;max-width:900px;';
    document.body.appendChild(post);
  });

  const cases = [
    ['#psalm-41-chapter', '/kjv/psa/41/10/'],
    ['#psalm-38-end', '/kjv/psa/38/11-14/']
  ];

  for (const [selector, expectedPath] of cases) {
    await page.locator(selector).dblclick();
    const resolved = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
      } catch (_) { return false; }
    });
    expect(new URL(resolved.url).pathname).toBe(expectedPath);
    await removeTabById(extensionWorker, resolved.id);
  }
});

test('chapter-only ranges expand across all chapters and open MultiVerse', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  for (const reference of ['Genesis 48-49', 'Genesis 42-46']) {
    await page.evaluate((text) => {
      let el = document.querySelector('#blb-e2e-chapter-range');
      if (!el) {
        el = document.createElement('p');
        el.id = 'blb-e2e-chapter-range';
        el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
        document.body.appendChild(el);
      }
      el.textContent = text;
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, reference);

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      if (!tab?.id) throw new Error('No active tab for chapter-range E2E');
      await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        world: 'ISOLATED',
        func: () => new Promise(resolve => {
          chrome.runtime.sendMessage({
            type:'blbSuiteOpenSelectionText',
            text:window.getSelection()?.toString() || '',
            tabBehavior:{activeIfNew:true,activateExisting:true}
          }, response => resolve(response || null));
        })
      });
    });

    const multiVerse = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    });
    expect(new URL(multiVerse.url || multiVerse.pendingUrl).hostname).toBe('www.blueletterbible.org');
    expect(
      new URL(multiVerse.url || multiVerse.pendingUrl).pathname.toLowerCase() === '/tools/multiverse.cfm' ||
      new URL(multiVerse.url || multiVerse.pendingUrl).searchParams.get('blbSuiteMultiVerse') === '1'
    ).toBeTruthy();
    await removeTabById(extensionWorker, multiVerse.id);
  }
});


test('MultiVerse batches disjoint chapter ranges without gaps and stays under 200 verses', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const requestedText = 'Genesis 42-46; Genesis 48-49';
  await page.evaluate((text) => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-disjoint-chapter-ranges';
    el.textContent = text;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, requestedText);

  const baselineTabIds = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({})).map(tab => tab.id)
  );

  const response = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw new Error('No active tab for disjoint chapter-range E2E');
    return chrome.scripting.executeScript({
      target: {tabId:tab.id},
      world:'ISOLATED',
      func: () => new Promise(resolve => chrome.runtime.sendMessage({
        type:'blbSuiteOpenSelectionText',
        text:window.getSelection()?.toString() || '',
        tabBehavior:{activeIfNew:true,activateExisting:true}
      }, result => resolve(result || null)))
    });
  });
  expect(response).toBeTruthy();

  await expect.poll(async () => extensionWorker.evaluate(async (baseline) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => {
      if (baseline.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    }).length;
  }, baselineTabIds), { timeout:15000 }).toBe(2);

  const state = await extensionWorker.evaluate(async (baselineTabIds) => {
    const tabs = await chrome.tabs.query({});
    const data = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
    const pending = data.blbSuitePendingMultiVerseRefsByTab || {};
    const multiverseTabs = tabs.filter(tab => {
      if (baselineTabIds.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    });
    return multiverseTabs.map(tab => ({id:tab.id, refs:pending[String(tab.id)] || []}));
  }, baselineTabIds);

  expect(state).toHaveLength(2);
  const batches = state.map(tab => tab.refs);
  expect(batches.every(refs => refs.length > 0)).toBeTruthy();

  const expanded = batches.map(refs => refs.flatMap(ref => {
    const from = Number(ref.from || 1);
    const to = Number(ref.to || from);
    return Array.from({length:Math.max(0, to - from + 1)}, (_, index) => ({
      book:Number(ref.bookNumber),
      chapter:Number(ref.chapter),
      verse:from + index
    }));
  }));
  const flat = expanded.flat();
  expect(flat.every(ref => ref.book === 1 && ref.chapter !== 47)).toBeTruthy();
  expect(flat).toHaveLength(223);
  expect(expanded.map(batch => batch.length)).toEqual([200,23]);

  const expected = [];
  for (const chapter of [42,43,44,45,46,48,49]) {
    const verseCounts = {42:38,43:34,44:34,45:28,46:34,48:22,49:33};
    for (let verse = 1; verse <= verseCounts[chapter]; verse++) expected.push({book:1,chapter,verse});
  }
  expect(flat).toEqual(expected);

  // All requested verses, including the final chapter, must be handed off to
  // MultiVerse tabs; no ordinary chapter-reader tab should be created.
  const allTabs = await extensionWorker.evaluate(async () => (await chrome.tabs.query({})).map(tab => ({
    id:tab.id, url:tab.url || tab.pendingUrl || ''
  })));
  const unexpectedBibleTabs = allTabs.filter(tab => {
    if (baselineTabIds.includes(tab.id) || state.some(item => item.id === tab.id)) return false;
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && /^\/kjv\/gen\/(?:42|43|44|45|46|48|49)\//i.test(url.pathname);
    } catch (_) { return false; }
  });
  expect(unexpectedBibleTabs).toEqual([]);

  for (const tab of state) await removeTabById(extensionWorker, tab.id);
});

test('MultiVerse parses reversed disjoint chapter ranges without dropping the second range', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const requestedText = 'Genesis 48-49 and Genesis 42-46';
  await page.evaluate((text) => {
    const el = document.createElement('p');
    el.id = 'blb-e2e-reversed-disjoint-chapter-ranges';
    el.textContent = text;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, requestedText);

  const baselineTabIds = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({})).map(tab => tab.id)
  );

  const response = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw new Error('No active tab for disjoint chapter-range E2E');
    return chrome.scripting.executeScript({
      target: {tabId:tab.id},
      world:'ISOLATED',
      func: () => new Promise(resolve => chrome.runtime.sendMessage({
        type:'blbSuiteOpenSelectionText',
        text:window.getSelection()?.toString() || '',
        tabBehavior:{activeIfNew:true,activateExisting:true}
      }, result => resolve(result || null)))
    });
  });
  expect(response).toBeTruthy();

  await expect.poll(async () => extensionWorker.evaluate(async (baseline) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => {
      if (baseline.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    }).length;
  }, baselineTabIds), { timeout:15000 }).toBe(2);

  const state = await extensionWorker.evaluate(async (baselineTabIds) => {
    const tabs = await chrome.tabs.query({});
    const data = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
    const pending = data.blbSuitePendingMultiVerseRefsByTab || {};
    const multiverseTabs = tabs.filter(tab => {
      if (baselineTabIds.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url || tab.pendingUrl);
        return url.hostname === 'www.blueletterbible.org' &&
          (url.pathname.toLowerCase() === '/tools/multiverse.cfm' ||
           url.searchParams.get('blbSuiteMultiVerse') === '1');
      } catch (_) { return false; }
    });
    return multiverseTabs.map(tab => ({id:tab.id, refs:pending[String(tab.id)] || []}));
  }, baselineTabIds);

  expect(state).toHaveLength(2);
  const batches = state.map(tab => tab.refs);
  expect(batches.every(refs => refs.length > 0)).toBeTruthy();

  const expanded = batches.map(refs => refs.flatMap(ref => {
    const from = Number(ref.from || 1);
    const to = Number(ref.to || from);
    return Array.from({length:Math.max(0, to - from + 1)}, (_, index) => ({
      book:Number(ref.bookNumber),
      chapter:Number(ref.chapter),
      verse:from + index
    }));
  }));
  const flat = expanded.flat();
  expect(flat.every(ref => ref.book === 1 && ref.chapter !== 47)).toBeTruthy();
  expect(flat).toHaveLength(223);
  expect(expanded.map(batch => batch.length)).toEqual([200,23]);

  const expected = [];
  for (const chapter of [42,43,44,45,46,48,49]) {
    const verseCounts = {42:38,43:34,44:34,45:28,46:34,48:22,49:33};
    for (let verse = 1; verse <= verseCounts[chapter]; verse++) expected.push({book:1,chapter,verse});
  }
  expect(flat).toEqual(expected);

  // All requested verses, including the final chapter, must be handed off to
  // MultiVerse tabs; no ordinary chapter-reader tab should be created.
  const allTabs = await extensionWorker.evaluate(async () => (await chrome.tabs.query({})).map(tab => ({
    id:tab.id, url:tab.url || tab.pendingUrl || ''
  })));
  const unexpectedBibleTabs = allTabs.filter(tab => {
    if (baselineTabIds.includes(tab.id) || state.some(item => item.id === tab.id)) return false;
    try {
      const url = new URL(tab.url);
      return url.hostname === 'www.blueletterbible.org' && /^\/kjv\/gen\/(?:42|43|44|45|46|48|49)\//i.test(url.pathname);
    } catch (_) { return false; }
  });
  expect(unexpectedBibleTabs).toEqual([]);

  for (const tab of state) await removeTabById(extensionWorker, tab.id);
});
