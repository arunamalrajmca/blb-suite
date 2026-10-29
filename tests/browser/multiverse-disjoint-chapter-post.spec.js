const { test, expect } = require('./fixtures');

async function submitSelection(page, extensionWorker, selectionId, requestedText, submittedPayloads) {
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.context().route('https://www.blueletterbible.org/tools/**', async route => {
    if (route.request().method() === 'POST') {
      submittedPayloads.push(new URLSearchParams(route.request().postData() || '').get('mvText') || '');
    }
    await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body>POST captured</body></html>'});
  });
  await page.evaluate(({text,id}) => {
    const el = document.createElement('p');
    el.id = id;
    el.textContent = text;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, {text:requestedText,id:selectionId});
  const response = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw new Error('No active tab for disjoint chapter-range E2E');
    return chrome.scripting.executeScript({
      target:{tabId:tab.id}, world:'ISOLATED',
      func:() => new Promise(resolve => chrome.runtime.sendMessage({
        type:'blbSuiteOpenSelectionText',
        text:window.getSelection()?.toString() || '',
        tabBehavior:{activeIfNew:true,activateExisting:true}
      }, result => resolve(result || null)))
    });
  });
  expect(response).toBeTruthy();
  await expect.poll(() => submittedPayloads.length, {timeout:20000}).toBe(2);
}

async function readBatches(extensionWorker, payloads) {
  return extensionWorker.evaluate(values => values.map(payload =>
    resolveBibleReferenceText(payload).map(ref => ({
      book:Number(resolveBibleBook(ref.book)?.bookNumber),
      chapter:Number(ref.chapter),
      from:Number(ref.from || 1),
      to:Number(ref.to || ref.from || 1)
    }))
  ), payloads);
}

function expandBatches(batches) {
  return batches.flatMap(refs => refs.flatMap(ref =>
    Array.from({length:Math.max(0,ref.to-ref.from+1)},(_,index)=>({
      book:ref.book,chapter:ref.chapter,verse:ref.from+index
    }))
  ));
}

function expectedGenesisVerses() {
  const expected = [];
  const verseCounts = {42:38,43:34,44:34,45:28,46:34,48:22,49:33};
  for (const chapter of [42,43,44,45,46,48,49]) {
    for (let verse=1;verse<=verseCounts[chapter];verse++) expected.push({book:1,chapter,verse});
  }
  return expected;
}

test('MultiVerse batches disjoint chapter ranges without gaps and stays under 200 verses', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({masterEnabled:true});
  const submittedPayloads = [];
  await submitSelection(page,extensionWorker,'blb-e2e-disjoint-chapter-ranges','Genesis 42-46; Genesis 48-49',submittedPayloads);
  const batches = await readBatches(extensionWorker,submittedPayloads);
  expect(batches).toHaveLength(2);
  expect(batches.every(refs=>refs.length>0)).toBeTruthy();
  expect(batches.every(refs=>refs.length<=200)).toBeTruthy();
  const flat = expandBatches(batches);
  expect(flat).toHaveLength(223);
  expect(new Set(flat.map(ref=>ref.book+':'+ref.chapter+':'+ref.verse)).size).toBe(223);
  flat.sort((a,b)=>a.book-b.book||a.chapter-b.chapter||a.verse-b.verse);
  expect(flat).toEqual(expectedGenesisVerses());
});

test('MultiVerse parses reversed disjoint chapter ranges without dropping the second range', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({masterEnabled:true});
  const submittedPayloads = [];
  await submitSelection(page,extensionWorker,'blb-e2e-reversed-disjoint-chapter-ranges','Genesis 48-49 and Genesis 42-46',submittedPayloads);
  const batches = await readBatches(extensionWorker,submittedPayloads);
  expect(batches).toHaveLength(2);
  expect(batches.every(refs=>refs.length>0)).toBeTruthy();
  expect(batches.every(refs=>refs.length<=200)).toBeTruthy();
  const flat = expandBatches(batches);
  expect(flat).toHaveLength(223);
  expect(new Set(flat.map(ref=>ref.book+':'+ref.chapter+':'+ref.verse)).size).toBe(223);
  flat.sort((a,b)=>a.book-b.book||a.chapter-b.chapter||a.verse-b.verse);
  expect(flat).toEqual(expectedGenesisVerses());
});
