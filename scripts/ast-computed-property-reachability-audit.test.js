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

test('propagates aliases and literal arguments into local function parameters', () => {
  const result = run({
    'main.js': "const service = { start() {}, stop() {} }; function dispatch(key) { service[key](); } const selected = 'start'; const alias = selected; dispatch(alias);"
  });
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.observations.length, 0, 'bounded parameter values should resolve');
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
  assert.equal(separate.observations[0].status, 'receiver-or-key-unknown');
});

test('does not treat computed writes as proof that a property is read or invoked', () => {
  const result = run({
    'main.js': "const target = { start() {} }; const key = getKey(); target[key] = handler;"
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].role, 'write');
  assert.equal(result.observations[0].candidateProperties, ['start']);
});
