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

test('tracks instance fields and methods through class this properties and construction', () => {
  const result = audit([
    'const callback = () => start();',
    'class Base {',
    '  constructor() { this.onReady = callback; }',
    '  invoke() { return this.onReady; }',
    '}',
    'class Child extends Base {}',
    'const instance = new Child();',
    'const handler = instance.onReady;',
    'const method = instance.invoke;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@8'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@4' && edge.to === 'method@9'));
});

test('tracks class instance fields and static class methods as property values', () => {
  const result = audit([
    'const callback = () => start();',
    'class Registry {',
    '  onReady = callback;',
    '  static onStop() { stop(); }',
    '}',
    'const instance = new Registry();',
    'const handler = instance.onReady;',
    'const staticHandler = Registry.onStop;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@7'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@4' && edge.to === 'staticHandler@8'));
});


test('traces object-property callback values stored in and retrieved from containers', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = { onReady: callback };',
    'const registry = new Map();',
    "registry.set('ready', source.onReady);",
    "const handler = registry.get('ready');"
  ].join('\n'));
  const storedValue = result.flowEdges.find(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to.startsWith('container-value@'));
  assert.ok(storedValue, 'expected callback property to flow into the container value slot');
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === storedValue.to && edge.to === 'handler@5'));
});

test('traces object-property values returned from helper functions', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    'function getHandler() { return registry.onReady; }',
    'const handler = getHandler();'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@4'));
});

test('connects Reflect.get values to consumers using literal and dynamic keys', () => {
  const result = audit([
    'const ready = () => start();',
    'const stopped = () => stop();',
    'const registry = { onReady: ready, onStop: stopped };',
    "const handler = Reflect.get(registry, 'onReady');",
    'const dynamicHandler = Reflect.get(registry, selectedKey);'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'dynamicHandler@5'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@2' && edge.to === 'dynamicHandler@5'));
});

test('connects Object.getOwnPropertyDescriptor values to later descriptor.value reads', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    "const descriptor = Object.getOwnPropertyDescriptor(registry, 'onReady');",
    'const handler = descriptor.value;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@4'));
});


test('traces nested object-property values returned from helper functions', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = { handlers: { onReady: callback } };',
    'function getHandler() { return source.handlers.onReady; }',
    'const handler = getHandler();'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@4'));
});

test('traces nested object-property values stored in and retrieved from containers', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = { handlers: { onReady: callback } };',
    'const registry = new Map();',
    "registry.set('ready', source.handlers.onReady);",
    "const handler = registry.get('ready');"
  ].join('\n'));
  const storedValue = result.flowEdges.find(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to.startsWith('container-value@'));
  assert.ok(storedValue, 'expected nested callback property to flow into the container value slot');
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === storedValue.to && edge.to === 'handler@5'));
});


test('traces nested member paths to deeply stored property values', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { nested: { ready: callback } };',
    'const handler = registry.nested.ready;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@3'));
});

test('traces descriptor values returned by Object.getOwnPropertyDescriptors', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    'const descriptors = Object.getOwnPropertyDescriptors(registry);',
    'const handler = descriptors.onReady.value;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@4'));
});

test('traces callback values exposed through Object.values and Object.entries', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    'const values = Object.values(registry);',
    'const valueHandler = values[0];',
    'const entries = Object.entries(registry);',
    'const entryHandler = entries[0][1];'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'valueHandler@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'entryHandler@6'));
});

test('traces nested values through the top-level descriptor value boundary', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { nested: { onReady: callback } };',
    'const descriptors = Object.getOwnPropertyDescriptors(registry);',
    'const handler = descriptors.nested.value.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@4'));
});

test('traces callback values through Object.fromEntries(Object.entries(source))', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    'const restored = Object.fromEntries(Object.entries(registry));',
    'const handler = restored.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@4'));
});

test('traces callback values through separately stored Object.entries collections', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    'const entries = Object.entries(registry);',
    'const restored = Object.fromEntries(entries);',
    'const handler = restored.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@5'));
});

test('traces callback values through literal Object.fromEntries pairs', () => {
  const result = audit([
    'const callback = () => start();',
    "const restored = Object.fromEntries([['onReady', callback]]);",
    'const handler = restored.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@3'));
});


test('traces callbacks retrieved from array containers with pop and shift', () => {
  const result = audit([
    'const callback = () => start();',
    'const stack = [];',
    'stack.push(callback);',
    'const popped = stack.pop();',
    'const queue = [];',
    'queue.push(callback);',
    'const shifted = queue.shift();'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'callback@1' && edge.to === 'popped@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'callback@1' && edge.to === 'shifted@7'));
});

test('traces callbacks retrieved from array containers with at and a literal index', () => {
  const result = audit([
    'const callback = () => start();',
    'const handlers = [];',
    'handlers.push(callback);',
    'const selected = handlers.at(0);'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'callback@1' && edge.to === 'selected@4'));
});

test('traces callback values through slice and filter array copies', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = [callback];',
    'const sliced = source.slice();',
    'const filtered = source.filter(() => true);',
    'const fromSlice = sliced.at(0);',
    'const fromFilter = filtered.at(0);'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'fromSlice@5'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'fromFilter@6'));
});

test('traces callback values through concat of array containers', () => {
  const result = audit([
    'const callback = () => start();',
    'const first = [callback];',
    'const second = [callback];',
    'const combined = first.concat(second);',
    'const selected = combined.at(1);'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'selected@5'));
});

test('traces callback values returned by array map transformations', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = [callback];',
    'const handlers = source.map(() => callback);',
    'const selected = handlers.at(0);'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'callback@1' && edge.to === 'selected@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'function-variable-identity' &&
    edge.from === 'function@1' && edge.to === 'callback@1'));
});

test('preserves nested callback properties through flatMap aggregate results', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = [0];',
    'const handlers = source.flatMap(() => [{ onReady: callback }]);',
    'const selected = handlers.at(0);',
    'const handler = selected.onReady;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@5'));
});

test('traces callback values returned by array find and findLast', () => {
  const result = audit([
    'const callback = () => start();',
    'const handlers = [callback];',
    'const found = handlers.find(() => true);',
    'const last = handlers.findLast(() => true);'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'found@3'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'last@4'));
});

test('traces callback values through splice results and array fill writes', () => {
  const result = audit([
    'const callback = () => start();',
    'const source = [callback];',
    'const removed = source.splice(0, 1);',
    'const selected = removed.at(0);',
    'const filled = [];',
    'filled.fill(callback);',
    'const fromFill = filled.at(0);'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'removed@3'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'selected@4'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'callback@1' && edge.to === 'fromFill@7'));
});

test('traces callback values through array for-of iteration', () => {
  const result = audit([
    'const callback = () => start();',
    'const handlers = [callback];',
    'for (const handler of handlers) { handler(); }'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@3'));
});

test('traces Map values through iterator next objects and direct next value reads', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = new Map();',
    "registry.set('onReady', callback);",
    'const iterator = registry.values();',
    'const step = iterator.next();',
    'const selected = step.value;',
    'const direct = iterator.next().value;'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'property-value-read' &&
    edge.from === 'callback@1' && edge.to === 'selected@6'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'callback@1' && edge.to === 'direct@7'));
});

test('traces callback values through Object.entries for-of destructuring', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = { onReady: callback };',
    'for (const [key, handler] of Object.entries(registry)) { handler(); }'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'function@1' && edge.to === 'handler@3'));
});

test('traces Map entry values through stored iterators and destructured for-of loops', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = new Map();',
    "registry.set('onReady', callback);",
    'const iterator = registry.entries();',
    'for (const [key, handler] of iterator) { handler(); }'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.from === 'callback@1' && edge.to === 'handler@5'));
});


test('traces callbacks returned by nested factories inside object and array wrappers', () => {
  const result = audit([
    'function makeHandler() { return () => start(); }',
    'const wrapped = { handler: makeHandler() };',
    'const handlers = [makeHandler()];'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.from === 'function@1' &&
    edge.kind === 'object-wrap-factory-return-callback'));
  assert.ok(result.flowEdges.some(edge => edge.from === 'function@1' &&
    edge.kind === 'object-wrap-factory-return-callback' && edge.to.includes('handlers@3')));
});

test('traces async factory callback values through await inside object wrappers', () => {
  const result = audit([
    'const callback = () => start();',
    'async function makeHandler() { return callback; }',
    'const wrapped = { handler: await makeHandler() };'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.from === 'function@1' &&
    edge.kind === 'object-wrap-factory-return-callback'));
});

test('traces callback values through Promise.resolve before container storage and retrieval', () => {
  const result = audit([
    'const callback = () => start();',
    'const registry = [];',
    'registry.push(Promise.resolve(callback));',
    'const selected = registry.pop();'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.from === 'function@1' &&
    edge.kind === 'container-store-expression-transparent-call-callback'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'container-value-read' &&
    edge.to === 'selected@4'));
});


test('traces yielded callback values nested inside generator return wrappers', () => {
  const result = audit([
    'const callback = () => start();',
    'function* makeHandler() { return { handler: (yield callback) }; }',
    'const wrapped = makeHandler();'
  ].join('\n'));
  assert.ok(result.flowEdges.some(edge => edge.from === 'function@1' &&
    edge.kind === 'function-return-callback'));
});


test('traces callback values returned by object-literal methods when called directly', () => {
  const result = audit([
    'const api = { make() { return () => start(); } };',
    'const callback = api.make();'
  ].join('\\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'function-return-callback' &&
    edge.to === 'callback@2'));
});

test('traces object-method factory returns when nested inside another wrapper', () => {
  const result = audit([
    'const api = { make: function () { return () => start(); } };',
    'const wrapped = { handler: api.make() };'
  ].join('\\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'object-wrap-factory-return-callback' &&
    edge.to.includes('wrapped@2')));
});

test('does not guess between duplicate object-method names when resolving factories', () => {
  const result = audit([
    'const first = { make() { return () => firstWork(); } };',
    'const second = { make() { return () => secondWork(); } };',
    'const wrapped = { handler: first.make() };'
  ].join('\\n'));
  assert.ok(result.flowEdges.some(edge => edge.kind === 'object-wrap-factory-return-callback'));
});
