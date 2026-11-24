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
  ].join('\n'));
  const kinds = new Set(result.flowEdges.map(edge => edge.kind));
  for (const kind of [
    'identifier-alias', 'object-wrap', 'function-argument', 'function-return',
    'container-store', 'mutation-store', 'proxy-target-or-handler',
    'prototype-inheritance', 'closure-capture'
  ]) assert.ok(kinds.has(kind), 'expected flow edge: ' + kind);
});

test('propagates returned closures and nested object/array wrapper identities to call results', () => {
  const result = audit([
    'const service = {};',
    'const callback = () => service.run();',
    'function makeCallback() { return callback; }',
    'function makeNested() { return { hooks: [callback], state: { service } }; }',
    'const fromClosure = makeCallback();',
    'const fromWrapper = makeNested();'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'function-return-callback' &&
    edge.from === 'function@2' && edge.to === 'fromClosure@5'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'function-return-callback' &&
    edge.from === 'function@2' && edge.to === 'fromWrapper@6'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'function-return' &&
    edge.from === 'service@1' && edge.to === 'fromWrapper@6'));
});

test('connects container values to reads by matching static keys and conservatively handles dynamic keys', () => {
  const result = audit([
    'const registry = new Map();',
    'const ready = () => start();',
    'const stopped = () => stop();',
    "registry.set('ready', ready);",
    "registry.set('stopped', stopped);",
    "const handler = registry.get('ready');",
    'const dynamicHandler = registry.get(key);'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'ready@2' && edge.to === 'handler@6'));
  assert.ok(!result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'stopped@3' && edge.to === 'handler@6'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'stopped@3' && edge.to === 'dynamicHandler@7'));
});

test('tracks nested aggregate values stored in containers through subsequent reads', () => {
  const result = audit([
    'const registry = new Map();',
    'const service = {};',
    'const callback = () => service.run();',
    "registry.set('entry', { callbacks: [callback], service });",
    "const entry = registry.get('entry');"
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@3' && edge.to === 'entry@5'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'service@2' && edge.to === 'entry@5'));
});

test('connects object property assignments to later reads without conflating distinct static keys', () => {
  const result = audit([
    'const registry = {};',
    'const ready = () => start();',
    'const stopped = () => stop();',
    'registry.onReady = ready;',
    'registry.onStop = stopped;',
    'const handler = registry.onReady;',
    'registry.onReady();'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@2' && edge.to === 'handler@6'));
  assert.ok(!result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@3' && edge.to === 'handler@6'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@2' && edge.to === 'property-read@7'));
});

test('tracks callback values in nested object and array literal properties through property reads', () => {
  const result = audit([
    'const callback = () => start();',
    'const wrapper = { hooks: [callback], nested: { ready: callback } };',
    'const hooks = wrapper.hooks;',
    'const nested = wrapper.nested;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'hooks@3'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'nested@4'));
});

test('keeps dynamic object-property reads conservative across stored properties', () => {
  const result = audit([
    'const registry = {};',
    'const first = () => start();',
    'const second = () => stop();',
    'registry.first = first;',
    'registry.second = second;',
    'const selected = registry[key];'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@2' && edge.to === 'selected@6'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@3' && edge.to === 'selected@6'));
});

test('preserves property stores and reads across multiple object aliases', () => {
  const result = audit([
    'const registry = {};',
    'const firstAlias = registry;',
    'const secondAlias = firstAlias;',
    'const callback = () => start();',
    'secondAlias.onReady = callback;',
    'const handler = registry.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@4' && edge.to === 'handler@6'));
});

test('connects property writes through the original object to reads through an assigned alias', () => {
  const result = audit([
    'const registry = {};',
    'let alias = {};',
    'alias = registry;',
    'const callback = () => start();',
    'registry.onReady = callback;',
    'const handler = alias.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@4' && edge.to === 'handler@6'));
});

test('propagates property values through object spread and chained spread copies', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = { onReady: callback };',
    'const merged = { ...source };',
    'const chained = { ...merged };',
    'const handler = chained.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@5'));
});

test('propagates property values through Object.assign into existing and newly assigned objects', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = { onReady: callback };',
    'const target = {};',
    'Object.assign(target, source);',
    'const first = target.onReady;',
    'const copied = Object.assign({}, source);',
    'const second = copied.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'first@5'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'second@7'));
});

test('connects object property values to renamed and shorthand destructured bindings', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback, onStop: callback };',
    'const { onReady: handler, onStop } = registry;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@3'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'onStop@3'));
});

test('traces nested object and array property destructuring to their source values', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { hooks: [callback], nested: { ready: callback } };',
    'const { hooks: [arrayHandler], nested: { ready: nestedHandler } } = registry;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'arrayHandler@3'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'nestedHandler@3'));
});

test('connects Object.defineProperty and Object.defineProperties descriptors to later reads', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = {};',
    "Object.defineProperty(registry, 'onReady', { value: callback });",
    'Object.defineProperties(registry, { onStop: { value: callback }, onGet: { get: callback } });',
    'const ready = registry.onReady;',
    'const stopped = registry.onStop;',
    'const getter = registry.onGet;'
  ].join('\n'));
  for (const target of ['ready@5', 'stopped@6', 'getter@7']) {
    assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
      edge.from === 'function@1' && edge.to === target), 'expected descriptor flow to ' + target);
  }
});

test('connects Reflect.set values to static reads and keeps dynamic writes conservative', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = {};',
    "Reflect.set(registry, 'onReady', callback);",
    'const ready = registry.onReady;',
    'Reflect.set(registry, dynamicKey, callback);',
    'const stopped = registry.onStop;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'ready@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'stopped@6'));
});

test('propagates inherited property values through Object.create and Object.setPrototypeOf', () => {
  const result = audit([
    'const callback = () => start();',
    'const prototype = { onReady: callback };',
    'const instance = Object.create(prototype);',
    'const first = instance.onReady;',
    'const secondInstance = {};',
    'Object.setPrototypeOf(secondInstance, prototype);',
    'const second = secondInstance.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'first@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'second@7'));
});

test('tracks properties inherited from an inline Object.create prototype literal', () => {
  const result = audit([
    'const callback = () => start();',
    'const instance = Object.create({ onReady: callback });',
    'const handler = instance.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@3'));
});


test('preserves returned aggregate identity so later property reads retain nested callbacks', () => {
  const result = audit([
    'const callback = () => start();',
    'function createEntry() { return { onReady: callback, hooks: [callback] }; }',
    'const entry = createEntry();',
    'const handler = entry.onReady;',
    'const hooks = entry.hooks;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'hooks@5'));
});

test('preserves aggregate property identities through direct Map storage and retrieval', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = new Map();',
    "registry.set('entry', { onReady: callback });",
    "const entry = registry.get('entry');",
    'const handler = entry.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'aggregate@3:22' && edge.to === 'entry@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@5'));
});

test('preserves object aliases stored in containers through retrieval and property reads', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = new Map();',
    'const entry = { onReady: callback };',
    "registry.set('entry', entry);",
    "const restored = registry.get('entry');",
    'const handler = restored.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@6'));
});


test('connects callbacks stored in object properties to event and promise scheduler registrations', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    "bus.on('ready', registry.onReady);",
    "target.addEventListener('ready', registry.onReady);",
    'Promise.resolve().then(registry.onReady);'
  ].join('\n'));
  for (const line of [3, 4, 5]) {
    assert.ok(result.findings.some(item => item.category === 'callbacks' &&
      item.kind === 'stored-property-callback-registration' && item.line === line));
    assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
      edge.from === 'function@1' && edge.to === 'scheduler@' + line));
  }
});

test('recognizes invocation of a callback stored in an object property', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    'registry.onReady();'
  ].join('\n'));
  assert.ok(has(result, 'callbacks', 'stored-property-callback-invocation'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'callback-invocation@3'));
});
