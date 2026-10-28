const { test, expect } = require('./fixtures');

test.describe('remaining omnibox command routing', () => {
  test.describe.configure({ mode: 'serial' });

  test('dict opens only a single ASCII word and safely falls back for invalid input', async ({ extensionWorker }) => {
    const results = await extensionWorker.evaluate(async () => {
      const originalUpdate = chrome.tabs.update;
      const navigations = [];
      chrome.tabs.update = async details => {
        navigations.push(details.url);
        return {};
      };
      try {
        for (const input of ['dict Grace', 'DICT mercy', 'dict grace works', 'dict grace!', 'dict']) {
          navigations.push('---' + input);
          await handleOmniboxCommand(input, 'currentTab');
        }
        return navigations;
      } finally {
        chrome.tabs.update = originalUpdate;
      }
    });

    expect(results).toEqual([
      '---dict Grace',
      'https://webstersdictionary1828.com/Dictionary/Grace',
      '---DICT mercy',
      'https://webstersdictionary1828.com/Dictionary/mercy',
      '---dict grace works',
      'https://webstersdictionary1828.com/',
      '---dict grace!',
      'https://webstersdictionary1828.com/',
      '---dict',
      'https://webstersdictionary1828.com/'
    ]);
  });

  test('excessive chapter and verse numbers clamp through the omnibox reference resolver', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const originalUpdate = chrome.tabs.update;
      const originalRecordStudyEntry = recordStudyEntry;
      const navigations = [];
      chrome.tabs.update = async details => { navigations.push(details.url); return {}; };
      recordStudyEntry = async () => {};
      try {
        for (const input of ['Romans 185 5', 'Romans 16 5', 'Romans 185', 'Romans 5 185']) {
          await handleBCommand(input, 'currentTab');
        }
        return navigations;
      } finally {
        chrome.tabs.update = originalUpdate;
        recordStudyEntry = originalRecordStudyEntry;
      }
    });
    expect(result).toEqual([
      'https://www.blueletterbible.org/kjv/rom/16/5/',
      'https://www.blueletterbible.org/kjv/rom/16/5/',
      'https://www.blueletterbible.org/kjv/rom/16/',
      'https://www.blueletterbible.org/kjv/rom/5/21/'
    ]);
  });

  test('cs command is gated by the master switch and forwards the disposition', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const originalIsSuiteEnabled = isSuiteEnabled;
      const originalRecordStudySearchTerm = recordStudySearchTerm;
      const originalHandleCaseSensitiveBCommand = handleCaseSensitiveBCommand;
      const originalHandleBCommand = handleBCommand;
      const calls = [];
      try {
        isSuiteEnabled = async () => false;
        recordStudySearchTerm = async value => { calls.push(['record', value]); };
        handleCaseSensitiveBCommand = async (value, disposition) => {
          calls.push(['cs', value, disposition]);
        };
        handleBCommand = async (value, disposition) => {
          calls.push(['b', value, disposition]);
        };

        await handleOmniboxCommand('cs faith and hope', 'newBackgroundTab');
        const whileDisabled = [...calls];

        isSuiteEnabled = async () => true;
        await handleOmniboxCommand('cs faith and hope', 'newBackgroundTab');
        await handleOmniboxCommand('John 3:16', 'newBackgroundTab');
        return { whileDisabled, calls };
      } finally {
        isSuiteEnabled = originalIsSuiteEnabled;
        recordStudySearchTerm = originalRecordStudySearchTerm;
        handleCaseSensitiveBCommand = originalHandleCaseSensitiveBCommand;
        handleBCommand = originalHandleBCommand;
      }
    });

    expect(result.whileDisabled).toEqual([]);
    expect(result.calls).toEqual([
      ['record', 'cs faith and hope'],
      ['cs', 'cs faith and hope', 'newBackgroundTab'],
      ['b', 'John 3:16', 'newBackgroundTab']
    ]);
  });
});
