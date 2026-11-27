'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('./ast-computed-property-reachability-audit');

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computed-property-audit-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    return analyze(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('recognizes finite conditional key sets and receiver-owned properties', () => {
  const result = run({
    'main.js': "const service = { start() {}, stop() {}, reset() {} }; const key = flag ? 'start' : 'stop'; service[key]();"
  });
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.observations.length, 0, 'finite literal key unions are not unresolved');
});

test('propagates constant key aliases through local bindings', () => {
  const result = run({
    'main.js': "const service = { start() {}, stop() {} }; const selected = 'start'; const alias = selected; service[alias]();"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 0, 'constant aliases are bounded');
});

test('retains unknown keys but reports bounded receiver candidates without claiming a target', () => {
  const result = run({
    'main.js': "const registry = { alpha() {}, beta() {} }; const key = readFromStorage(); registry[key]();"
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].status, 'receiver-properties-known-key-unknown');
  assert.deepEqual(result.observations[0].candidateProperties, ['alpha', 'beta']);
  assert.equal(result.observations[0].role, 'call');
});

test('tracks class methods and prototype assignments as receiver candidates', () => {
  const result = run({
    'main.js': "class Worker { start() {} stop() {} } Worker.prototype.reset = function() {}; const key = getKey(); new Worker()[key]();"
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].candidateCount, 0, 'complex receiver expressions are not attributed to an owner');
  const separate = run({
    'main.js': "class Worker { start() {} stop() {} } Worker.prototype.reset = function() {}; const key = getKey(); const worker = new Worker(); worker[key]();"
  });
  assert.equal(separate.observations.length, 1);
  assert.equal(separate.observations[0].status, 'receiver-properties-known-key-unknown');
  assert.deepEqual(separate.observations[0].candidateProperties, ['reset', 'start', 'stop']);
});

test('does not treat computed writes as proof that a property is read or invoked', () => {
  const result = run({
    'main.js': "const target = { start() {} }; const key = getKey(); target[key] = handler;"
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].role, 'write');
  assert.deepEqual(result.observations[0].candidateProperties, ['start']);
});

test('propagates exported object ownership and constant keys through named imports and re-exports', () => {
  const result = run({
    'lib/service.js': 'export const registry = { start() {}, stop() {} }; export const DEFAULT_METHOD = "start";',
    'lib/facade.js': "export { registry, DEFAULT_METHOD as METHOD } from './service.js';",
    'main.js': "import { registry, METHOD } from './lib/facade.js'; const alias = registry; const key = readFromStorage(); alias[key](); registry[METHOD];"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].status, 'receiver-properties-known-key-unknown');
  assert.deepEqual(result.observations[0].candidateProperties, ['start', 'stop']);
});

test('propagates property ownership from a default-exported object', () => {
  const result = run({
    'lib/router.js': 'export default { open() {}, close() {} };',
    'main.js': "import router from './lib/router.js'; const key = getRuntimeKey(); router[key]();"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.observations[0].candidateProperties, ['close', 'open']);
});


test('classifies storage-backed object maps and records the dynamic key origin', () => {
  const result = run({
    'main.js': "async function update(origin, site) { const data = await chrome.storage.local.get({pageSites:{}}); const pageSites = data.pageSites && typeof data.pageSites === 'object' ? {...data.pageSites} : {}; pageSites[site] = true; return pageSites[origin]; }"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 2);
  for (const observation of result.observations) {
    assert.equal(observation.receiverKind, 'storage-backed-container');
    assert.equal(observation.storageField, 'pageSites');
    assert.equal(observation.keyDefinition, 'parameter-or-loop-binding');
  }
  const write = result.observations.find(item => item.role === 'write');
  assert.equal(write.valueExpression, 'true');
});

test('recognizes literal globalThis registries and inline object key domains', () => {
  const result = run({
    'registry.js': "globalThis.Registry = Object.freeze({alpha: 1, beta: 2});",
    'main.js': "const key = getKey(); globalThis.Registry[key]; ({'1':'I','2':'II','3':'III'})[key];"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.observations[0].candidateProperties, ['alpha', 'beta']);
  assert.deepEqual(result.observations[1].candidateProperties, ['1', '2', '3']);
});

test('classifies computed array accesses separately from object-key dispatch', () => {
  const result = run({
    'main.js': "const tokens = 'one two'.split(' '); const index = getIndex(); tokens[index];"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].receiverKind, 'array-like');
  assert.equal(result.observations[0].role, 'read-or-other');
});


test('propagates storage-backed container identity through a mutator callback', () => {
  const result = run({
    'main.js': "async function getTracked() { const data = await chrome.storage.local.get({tracked:{}}); return data.tracked && typeof data.tracked === 'object' ? {...data.tracked} : {}; } async function updateTracked(mutator) { const map = await getTracked(); await mutator(map); return map; } function caller() { updateTracked(map => { const key = getKey(); map[key] = {active:true}; return map[key]; }); }"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 2);
  for (const observation of result.observations) {
    assert.equal(observation.receiverKind, 'storage-backed-container');
    assert.equal(observation.storageField, 'tracked');
  }
});

test('tracks properties added through direct writes, Object.assign, and defineProperty', () => {
  const result = run({
    'main.js': "const target = {}; target.start = fn; Object.assign(target, {stop: fn}); Object.defineProperty(target, 'reset', {value:fn}); const key = getKey(); target[key]();"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.observations[0].candidateProperties, ['reset', 'start', 'stop']);
});

test('records computed-write values and distinguishes property deletion', () => {
  const result = run({
    'main.js': "const target = {}; const key = getKey(); target[key] = handler; delete target[key];"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 2);
  const write = result.observations.find(item => item.role === 'write');
  const deletion = result.observations.find(item => item.role === 'delete');
  assert.equal(write.valueExpression, 'handler');
  assert.equal(deletion.role, 'delete');
});


test('does not classify shadowed built-in names as array producers', () => {
  const result = run({
    'main.js': "function exercise(Array, Object, Promise) { let from, keys, all; from = Array.from(); keys = Object.keys(); all = Promise.all(); const index = getIndex(); from[index]; keys[index]; all[index]; }"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 3);
  assert.ok(result.observations.every(item => item.receiverKind !== 'array-like'));
});

test('continues to recognize unshadowed built-in array producers', () => {
  const result = run({
    'main.js': "let from; from = Array.from('abc'); const keys = Object.keys({a:1}); const all = Promise.all([]); const index = getIndex(); from[index]; keys[index]; all[index];"
  });
  assert.equal(result.parseErrors.length, 0, JSON.stringify(result.parseErrors));
  assert.equal(result.observations.length, 3);
  assert.ok(result.observations.every(item => item.receiverKind === 'array-like'));
});
