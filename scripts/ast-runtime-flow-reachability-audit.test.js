'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeFile, CATEGORIES } = require('./ast-runtime-flow-reachability-audit');

function audit(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-flow-audit-'));
  try {
    const file = path.join(root, 'fixture.js');
    fs.writeFileSync(file, source);
    return analyzeFile(root, file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function has(result, category, kind) {
  return result.findings.some(item => item.category === category && (!kind || item.kind === kind));
}

test('inventories closure captures as cross-scope reachability edges', () => {
  const result = audit('function outer() { const state = { run() {} }; return () => state.run(); }');
  assert.ok(has(result, 'closures', 'captured-outer-binding'));
});
test('recognizes callback registration through timers, promises, and event listeners', () => {
  const result = audit("setTimeout(() => work(), 1); Promise.resolve().then(function done() {}); target.addEventListener('change', () => work());");
  assert.ok(has(result, 'callbacks', 'callback-registration'));
  assert.ok(has(result, 'asynchronous-scheduling', 'scheduler-call'));
});
test('tracks object and array wrappers plus returned references', () => {
  const result = audit('const wrapped = { callback: () => work(), nested: service }; const list = [wrapped, () => work()]; function expose() { return list; }');
  assert.ok(has(result, 'object-wrapping', 'aggregate-wrapper'));
  assert.ok(has(result, 'object-wrapping', 'returned-reference'));
  assert.ok(has(result, 'callbacks', 'function-in-object-property'));
});
test('recognizes container construction and storage', () => {
  const result = audit("const registry = new Map(); registry.set('ready', handler); const weak = new WeakMap(); weak.set(owner, callback);");
  assert.ok(has(result, 'container-storage', 'container-construction'));
  assert.ok(has(result, 'container-storage', 'container-write'));
});
test('tracks explicit object mutation and reflective writes', () => {
  const result = audit("target.handler = callback; Object.assign(target, additions); Object.defineProperty(target, 'late', { value: handler }); Reflect.set(target, key, value);");
  assert.ok(has(result, 'mutation', 'member-assignment'));
  assert.ok(has(result, 'mutation', 'object-mutation-api'));
  assert.ok(has(result, 'mutation', 'reflective-property-write'));
});
test('recognizes asynchronous scheduling APIs', () => {
  const result = audit('queueMicrotask(() => run()); requestAnimationFrame(() => paint()); Promise.resolve().finally(() => cleanup());');
  assert.ok(result.findings.filter(item => item.category === 'asynchronous-scheduling').length >= 3);
});
test('tracks indirect method aliases and Function call/apply/bind', () => {
  const result = audit('const method = service.start; method(); service.stop.call(service); service.stop.apply(service, []); service.stop.bind(service); const { close } = service;');
  assert.ok(has(result, 'indirect-methods', 'method-value-alias'));
  assert.ok(has(result, 'indirect-methods', 'indirect-invocation'));
  assert.ok(has(result, 'indirect-methods', 'destructured-property-alias'));
});
test('recognizes reflective enumeration and dynamic property lookup', () => {
  const result = audit('Object.keys(registry); Object.getOwnPropertyNames(registry); Reflect.get(registry, key); for (const key in registry) consume(registry[key]); const copy = { ...registry };');
  assert.ok(has(result, 'reflection', 'reflective-api'));
  assert.ok(has(result, 'reflection', 'enumerated-object-keys'));
  assert.ok(has(result, 'reflection', 'spread-enumeration'));
  assert.ok(has(result, 'custom-runtime-dispatch', 'dynamic-member-lookup'));
});
test('recognizes Proxy-mediated access', () => {
  const result = audit('const proxy = new Proxy(target, { get(object, key) { return object[key]; } });');
  assert.ok(has(result, 'proxies', 'proxy-construction'));
});
test('recognizes prototype mutation and derived prototype objects', () => {
  const result = audit('Object.setPrototypeOf(target, prototype); const child = Object.create(prototype); target.__proto__ = prototype; const current = Object.getPrototypeOf(target);');
  assert.ok(has(result, 'prototype-mutation', 'prototype-set'));
  assert.ok(has(result, 'prototype-mutation', 'prototype-derived-object'));
  assert.ok(has(result, 'prototype-mutation', 'legacy-prototype-assignment'));
});
test('recognizes custom event dispatch and switch-based routing', () => {
  const result = audit("bus.emit('ready', payload); dispatcher.dispatch(action); switch (event.type) { case 'ready': run(); break; } handlers[event.type]();");
  assert.ok(has(result, 'custom-runtime-dispatch', 'dispatch-call'));
  assert.ok(has(result, 'custom-runtime-dispatch', 'switch-based-dispatch'));
  assert.ok(has(result, 'custom-runtime-dispatch', 'dynamic-member-lookup'));
});
test('publishes a stable category list covering every requested runtime mechanism', () => {
  assert.deepEqual(CATEGORIES, [
    'callbacks', 'closures', 'object-wrapping', 'container-storage', 'mutation',
    'asynchronous-scheduling', 'indirect-methods', 'reflection', 'proxies',
    'prototype-mutation', 'custom-runtime-dispatch'
  ]);
});

test('builds explicit directed edges for aliases, wrappers, calls, returns, containers, mutation, proxies, and prototypes', () => {
  const result = audit([
    'const service = {};',
    'const alias = service;',
    'const wrapped = { nested: service };',
    'function consume(target) { return target; }',
    'const returned = consume(alias);',
    'const registry = new Map(); registry.set("service", returned);',
    'const callback = () => service;',
    'const proxy = new Proxy(service, {});',
    'const prototype = {}; Object.setPrototypeOf(proxy, prototype);',
    'const target = {}; target.handler = callback;'
  ].join('\\n'));
  const kinds = new Set(result.flowEdges.map(edge => edge.kind));
  for (const kind of [
    'identifier-alias', 'object-wrap', 'function-argument', 'function-return',
    'container-store', 'mutation-store', 'proxy-target-or-handler',
    'prototype-inheritance', 'closure-capture'
  ]) assert.ok(kinds.has(kind), 'expected flow edge: ' + kind);
});
