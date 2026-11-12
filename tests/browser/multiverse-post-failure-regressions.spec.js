const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../extension/multiverse-post.js'),
  'utf8'
);

function createPostHarness({ search = '?mvText=John%203%3A16', queueResponses = [] } = {}) {
  const state = {
    status: { textContent: 'Opening the requested Bible references…' },
    messages: [],
    forms: [],
    queueCalls: 0
  };

  const document = {
    getElementById: id => id === 'status' ? state.status : null,
    createElement(tagName) {
      if (tagName === 'form') {
        const form = {
          method: '',
          acceptCharset: '',
          action: '',
          fields: [],
          appendChild(input) { this.fields.push(input); },
          submit() { state.forms.push(this); }
        };
        return form;
      }
      return { type: '', name: '', value: '' };
    },
    body: {
      appendChild(element) {
        element.appendedToBody = true;
      }
    }
  };

  const chrome = {
    runtime: {
      sendMessage(message) {
        state.messages.push(message);
        if (message.type !== 'blbSuiteAcquireMultiVersePostSlot') {
          return Promise.resolve({ ok: true });
        }
        state.queueCalls++;
        const next = queueResponses.length ? queueResponses.shift() : { ok: true, submitAt: Date.now() };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
    }
  };

  vm.runInNewContext(source, {
    document,
    chrome,
    location: {
      search,
      href: 'chrome-extension://test/multiverse-post.html' + search
    },
    URLSearchParams,
    Date,
    Promise,
    setTimeout,
    console: { info() {} }
  }, { filename: 'multiverse-post.js' });

  return state;
}

async function waitForTerminalState(state, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (state.forms.length || state.status.textContent !== 'Opening the requested Bible references…') {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('MultiVerse post handoff did not reach a terminal state');
}

test('MultiVerse post handoff rejects an empty reference payload before requesting a queue slot', async () => {
  const state = createPostHarness({ search: '?mvText=%20%20%20' });
  await waitForTerminalState(state);

  expect(state.queueCalls).toBe(0);
  expect(state.forms).toHaveLength(0);
  expect(state.status.textContent).toContain('No references were supplied');
});

test('MultiVerse post handoff reports queue admission failures without submitting a form', async () => {
  const state = createPostHarness({
    queueResponses: [{ ok: false, error: 'queue is temporarily unavailable' }]
  });
  await waitForTerminalState(state);

  expect(state.queueCalls).toBe(1);
  expect(state.forms).toHaveLength(0);
  expect(state.status.textContent).toContain('Unable to queue this Multi-Verse request');
  expect(state.status.textContent).toContain('queue is temporarily unavailable');
});

test('MultiVerse post handoff retries one dropped message channel and submits exactly once', async () => {
  const state = createPostHarness({
    search: '?mvText=John%203%3A16%3B%20Romans%208%3A1-2',
    queueResponses: [
      new Error('The message port closed before a response was received.'),
      { ok: true, submitAt: Date.now() }
    ]
  });
  await waitForTerminalState(state);

  expect(state.queueCalls).toBe(2);
  expect(state.forms).toHaveLength(1);
  const [form] = state.forms;
  expect(form.method).toBe('post');
  expect(form.acceptCharset).toBe('UTF-8');
  expect(form.action).toBe('https://www.blueletterbible.org/tools/MultiVerse.cfm');
  expect(Object.fromEntries(form.fields.map(input => [input.name, input.value]))).toEqual({
    refFormat: '4',
    refDelim: '3',
    numDelim: '0',
    abbrev: '0',
    quoted: '0',
    sqrbrkt: '0',
    sblabbrev: '0',
    endash: '0',
    sorted: '0',
    t: 'KJV',
    mvText: 'John 3:16; Romans 8:1-2'
  });
});

test('MultiVerse post handoff stops after the second dropped message channel', async () => {
  const state = createPostHarness({
    queueResponses: [
      new Error('first channel closed'),
      new Error('second channel closed')
    ]
  });
  await waitForTerminalState(state);

  expect(state.queueCalls).toBe(2);
  expect(state.forms).toHaveLength(0);
  expect(state.status.textContent).toContain('Multi-Verse queue connection failed after retry');
  expect(state.status.textContent).toContain('second channel closed');
});
