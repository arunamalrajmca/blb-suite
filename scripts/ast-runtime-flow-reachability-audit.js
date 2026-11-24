'use strict';

/**
 * Conservative runtime-flow inventory for JavaScript reachability audits.
 *
 * This analyzer does not claim that a property/function is dead. It inventories
 * runtime mechanisms that can carry references beyond ordinary static calls,
 * and marks their source locations as reachability uncertainty. The existing
 * lexical, owner-aware, module, and interprocedural analyzers remain the source
 * of candidate findings; this pass prevents those candidates from being
 * over-interpreted where runtime dispatch is involved.
 */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const EXCLUDED = new Set(['.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist']);
const EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const CATEGORIES = [
  'callbacks', 'closures', 'object-wrapping', 'container-storage', 'mutation',
  'asynchronous-scheduling', 'indirect-methods', 'reflection', 'proxies',
  'prototype-mutation', 'custom-runtime-dispatch'
];

function walkFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  visit(root);
  return files.sort();
}

function parse(source, filename) {
  let lastError;
  for (const sourceType of ['script', 'module']) {
    try {
      return acorn.parse(source, {
        ecmaVersion: 'latest', sourceType, locations: true, ranges: true,
        allowHashBang: true
      });
    } catch (error) { lastError = error; }
  }
  lastError.message = filename + ': ' + lastError.message;
  throw lastError;
}

function visit(node, callback, parent = null, ancestors = []) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  callback(node, parent, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, callback, node, next);
    } else if (value && typeof value.type === 'string') visit(value, callback, node, next);
  }
}

function propertyName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property.type === 'Literal' &&
      (typeof member.property.value === 'string' || typeof member.property.value === 'number')) {
    return String(member.property.value);
  }
  return null;
}

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') return propertyName(callee);
  return null;
}

function isFunction(node) {
  return !!node && [
    'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'
  ].includes(node.type);
}

function location(root, file, node, category, kind, detail) {
  return {
    category, kind,
    file: path.relative(root, file).split(path.sep).join('/'),
    line: node && node.loc ? node.loc.start.line : null,
    column: node && node.loc ? node.loc.start.column + 1 : null,
    detail: detail || null
  };
}

function analyzeFile(root, file) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = parse(source, file);
  const sourceType = ast.sourceType || 'script';
  const manager = eslintScope.analyze(ast, {
    ecmaVersion: 2022, sourceType, optimistic: false,
    ignoreEval: false, impliedStrict: false
  });
  const variableForNode = new Map();
  for (const scope of manager.scopes) {
    for (const variable of scope.variables || []) {
      for (const id of variable.identifiers || []) variableForNode.set(id, variable);
      for (const def of variable.defs || []) if (def.name) variableForNode.set(def.name, variable);
    }
    for (const reference of scope.references || []) {
      if (reference.resolved) variableForNode.set(reference.identifier, reference.resolved);
    }
  }

  const findings = [];
  const flowEdges = [];
  const bindingId = node => {
    const variable = node && variableForNode.get(node);
    if (!variable) {
      return node && node.type === 'Identifier'
        ? 'unresolved:' + node.name + '@' + (node.loc ? node.loc.start.line : 0)
        : null;
    }
    const definition = variable.identifiers && variable.identifiers[0];
    return variable.name + '@' + (definition && definition.loc ? definition.loc.start.line : 0);
  };
  const addEdge = (from, to, kind, node, detail) => {
    if (!from || !to) return;
    flowEdges.push({
      from, to, kind,
      file: path.relative(root, file).split(path.sep).join('/'),
      line: node && node.loc ? node.loc.start.line : null,
      detail: detail || null
    });
  };
  const add = (category, kind, node, detail) => findings.push(location(root, file, node, category, kind, detail));
  const containerWrites = [];
  const containerReads = [];
  const propertyWrites = [];
  const propertyReads = [];
  const propertySlot = (object, property) => object + '::property::' + property;
  const propertyKey = property => {
    if (!property) return null;
    if (!property.computed && property.type === 'Identifier') return property.name;
    if (property.computed && property.type === 'Literal' &&
        ['string', 'number'].includes(typeof property.value)) return String(property.value);
    return null;
  };
  const addObjectPropertySlots = (value, object, prefix = [], depth = 0) => {
    if (!value || depth > 10) return;
    if (value.type === 'ObjectExpression') {
      for (const property of value.properties) {
        if (property.type === 'SpreadElement') {
          const key = prefix.join('.');
          if (key) {
            const slot = propertySlot(object, key);
            const before = flowEdges.length;
            addContainedReferences(property.argument, slot, 'property-store-spread', property);
            for (const edge of flowEdges.slice(before)) propertyWrites.push({object, property:key, stored:edge.from});
          }
          continue;
        }
        if (property.type !== 'Property') continue;
        const key = propertyKey(property.key);
        if (key === null) continue;
        const fullPath = [...prefix, key];
        const slot = propertySlot(object, fullPath.join('.'));
        const before = flowEdges.length;
        addContainedReferences(property.value, slot, 'property-store', property);
        for (const edge of flowEdges.slice(before)) propertyWrites.push({object, property:fullPath.join('.'), stored:edge.from});
        if (property.value.type === 'ObjectExpression' || property.value.type === 'ArrayExpression') {
          addObjectPropertySlots(property.value, object, fullPath, depth + 1);
        }
      }
    } else if (value.type === 'ArrayExpression') {
      value.elements.forEach((element, index) => {
        if (!element) return;
        const fullPath = [...prefix, String(index)];
        const slot = propertySlot(object, fullPath.join('.'));
        const before = flowEdges.length;
        addContainedReferences(element, slot, 'property-store', value);
        for (const edge of flowEdges.slice(before)) propertyWrites.push({object, property:fullPath.join('.'), stored:edge.from});
        if (element.type === 'ObjectExpression' || element.type === 'ArrayExpression') {
          addObjectPropertySlots(element, object, fullPath, depth + 1);
        }
      });
    }
  };
  const literalKey = node => node && node.type === 'Literal' &&
    ['string', 'number'].includes(typeof node.value) ? String(node.value) : null;
  // Follow only value-bearing syntax. Function bodies are deliberately opaque:
  // their lexical captures are inventoried separately and must not be mistaken
  // for values eagerly stored in the wrapper.
  const addContainedReferences = (value, destination, kind, origin, depth = 0) => {
    if (!value || depth > 12) return;
    if (value.type === 'Identifier') {
      const fn = functionVariables.get(variableForNode.get(value));
      if (fn) addEdge('function@' + fn.loc.start.line, destination, kind + '-callback', origin || value, value.name);
      else addEdge(bindingId(value), destination, kind, origin || value, value.name);
      return;
    }
    if (isFunction(value)) {
      addEdge('function@' + value.loc.start.line, destination, kind + '-callback', origin || value, 'stored function value');
      return;
    }
    if (value.type === 'ObjectExpression') {
      for (const property of value.properties) {
        if (property.type === 'SpreadElement') addContainedReferences(property.argument, destination, kind + '-spread', origin || property, depth + 1);
        else if (property.type === 'Property') addContainedReferences(property.value, destination, kind, origin || property, depth + 1);
      }
      return;
    }
    if (value.type === 'ArrayExpression') {
      for (const element of value.elements) addContainedReferences(element, destination, kind, origin || value, depth + 1);
      return;
    }
    if (value.type === 'SequenceExpression') {
      for (const expression of value.expressions) addContainedReferences(expression, destination, kind, origin || value, depth + 1);
      return;
    }
    if (value.type === 'ConditionalExpression') {
      addContainedReferences(value.consequent, destination, kind, origin || value, depth + 1);
      addContainedReferences(value.alternate, destination, kind, origin || value, depth + 1);
      return;
    }
    if (value.type === 'LogicalExpression') {
      addContainedReferences(value.left, destination, kind, origin || value, depth + 1);
      addContainedReferences(value.right, destination, kind, origin || value, depth + 1);
      return;
    }
    if (value.type === 'MemberExpression' && value.object.type === 'Identifier') {
      addEdge(bindingId(value.object), destination, kind + '-member-value', origin || value, propertyName(value) || 'computed member');
    }
  };
  const returnedValues = fn => {
    const returned = [];
    const scan = (node, isRoot = false) => {
      if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
      if (!isRoot && isFunction(node)) return;
      if (node.type === 'ReturnStatement' && node.argument) returned.push(node.argument);
      for (const [key, value] of Object.entries(node)) {
        if (['loc', 'range', 'start', 'end'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(child => scan(child));
        else if (value && typeof value.type === 'string') scan(value);
      }
    };
    scan(fn.body, true);
    return returned;
  };
  const functionNodes = [];
  const functionVariables = new Map();
  const functionDeclarationsByName = new Map();
  visit(ast, (node, parent) => {
    if (isFunction(node)) {
      functionNodes.push(node);
      if (node.type === 'FunctionDeclaration' && node.id) {
        const variable = variableForNode.get(node.id);
        if (variable) functionVariables.set(variable, node);
        if (!functionDeclarationsByName.has(node.id.name)) functionDeclarationsByName.set(node.id.name, []);
        functionDeclarationsByName.get(node.id.name).push(node);
      }
      if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        const variable = variableForNode.get(parent.id);
        if (variable) functionVariables.set(variable, node);
      }
      if (parent && parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier') {
        const variable = variableForNode.get(parent.left);
        if (variable) functionVariables.set(variable, node);
      }
    }
  });

  // Lexical captures are function-to-outer-binding edges even when the function
  // is registered or invoked later by a runtime outside this source file.
  for (const scope of manager.scopes) {
    if (scope.type !== 'function') continue;
    for (const reference of scope.references || []) {
      if (!reference.resolved || reference.resolved.scope === scope) continue;
      const captured = reference.resolved.identifiers && reference.resolved.identifiers[0];
      const capturedId = captured ? bindingId(captured) : reference.resolved.name;
      const closureId = 'closure@' + (scope.block && scope.block.loc ? scope.block.loc.start.line : 0);
      add('closures', 'captured-outer-binding', scope.block || ast,
        reference.resolved.name + ' captured by nested function');
      addEdge(capturedId, closureId, 'closure-capture', scope.block || ast, reference.resolved.name);
    }
  }

  const callbackSchedulers = new Set([
    'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
    'then', 'catch', 'finally', 'addEventListener', 'removeListener',
    'addListener', 'on', 'once', 'subscribe', 'observe', 'watch',
    'requestAnimationFrame', 'requestIdleCallback', 'addEventListener', 'addListener', 'subscribe', 'observe', 'watch'
  ]);
  const asyncSchedulers = new Set([
    'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
    'then', 'catch', 'finally', 'requestAnimationFrame',
    'requestIdleCallback', 'postMessage', 'sendMessage'
  ]);
  const reflectiveMethods = new Set([
    'get', 'set', 'has', 'ownKeys', 'getOwnPropertyDescriptor',
    'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'getOwnPropertySymbols',
    'keys', 'values', 'entries', 'assign', 'defineProperty', 'defineProperties',
    'preventExtensions', 'seal', 'freeze'
  ]);
  const dispatchMethods = new Set([
    'emit', 'dispatch', 'dispatchEvent', 'sendMessage', 'postMessage',
    'notify', 'publish', 'invoke', 'execute', 'callHandler', 'handleEvent'
  ]);
  const containerMethods = new Set(['set', 'add', 'put', 'push', 'unshift', 'splice']);

  visit(ast, (node, parent, ancestors) => {
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = calleeName(node.callee);
      const receiver = node.callee && node.callee.type === 'MemberExpression'
        ? node.callee.object : null;
      const receiverName = receiver && receiver.type === 'Identifier' ? receiver.name : null;

      // Callback values are treated as first-class reachability edges, not as
      // ordinary arguments whose target must be synchronously called.
      for (let index = 0; index < node.arguments.length; index++) {
        const argument = node.arguments[index];
        if (isFunction(argument)) {
          const scheduler = callbackSchedulers.has(name) || name === 'addListener' ||
            (name === 'addEventListener' && index === 1);
          if (scheduler) {
            add('callbacks', 'callback-registration', argument,
              (name || 'call') + ' argument[' + index + ']');
            addEdge('function@' + argument.loc.start.line,
              'scheduler@' + node.loc.start.line, 'callback-registration', argument, name || 'call');
          }
        }
        if (argument.type === 'Identifier' && functionVariables.has(variableForNode.get(argument))) {
          if (callbackSchedulers.has(name)) {
            add('callbacks', 'function-reference-registration',
              argument, (name || 'call') + ' argument[' + index + ']');
            addEdge(bindingId(argument), 'scheduler@' + node.loc.start.line,
              'callback-reference', argument, name || 'call');
          }
        }
      }

      if (asyncSchedulers.has(name)) add('asynchronous-scheduling', 'scheduler-call', node,
        (receiverName ? receiverName + '.' : '') + name);

      if (node.type === 'NewExpression' && name === 'Proxy') {
        add('proxies', 'proxy-construction', node, 'Proxy target and handler can mediate property access');
        const assigned = parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier'
          ? bindingId(parent.id) : null;
        for (const argument of node.arguments.slice(0, 2)) {
          if (argument.type === 'Identifier') addEdge(bindingId(argument), assigned,
            'proxy-target-or-handler', node, argument.name);
        }
      }

      if (node.type === 'CallExpression' && name === 'Proxy') {
        add('proxies', 'proxy-factory-call', node, 'Proxy invoked without new');
      }

      if (node.type === 'CallExpression' && name === 'setPrototypeOf') {
        if (receiverName === 'Object' || receiverName === 'Reflect') {
          add('prototype-mutation', 'prototype-set', node, receiverName + '.setPrototypeOf');
          if (node.arguments[0] && node.arguments[0].type === 'Identifier' &&
              node.arguments[1] && node.arguments[1].type === 'Identifier') {
            addEdge(bindingId(node.arguments[1]), bindingId(node.arguments[0]),
              'prototype-inheritance', node, receiverName + '.setPrototypeOf');
          }
        }
      }
      if (node.type === 'CallExpression' && name === 'create' && receiverName === 'Object') {
        add('prototype-mutation', 'prototype-derived-object', node, 'Object.create prototype inheritance');
      }
      if (node.type === 'CallExpression' && name === 'getPrototypeOf' &&
          (receiverName === 'Object' || receiverName === 'Reflect')) {
        add('prototype-mutation', 'prototype-inspection', node, receiverName + '.getPrototypeOf');
      }

      if (node.type === 'CallExpression' && name && reflectiveMethods.has(name) &&
          (receiverName === 'Object' || receiverName === 'Reflect')) {
        add('reflection', 'reflective-api', node, receiverName + '.' + name);
      }
      if (node.type === 'CallExpression' && name === 'get' && receiverName === 'Reflect') {
        add('reflection', 'reflective-property-read', node, 'Reflect.get target/key');
      }
      if (node.type === 'CallExpression' && name === 'set' && receiverName === 'Reflect') {
        add('mutation', 'reflective-property-write', node, 'Reflect.set target/key/value');
      }

      if (node.type === 'CallExpression' && dispatchMethods.has(name)) {
        add('custom-runtime-dispatch', 'dispatch-call', node,
          (receiverName ? receiverName + '.' : '') + name);
      }

      if (node.type === 'CallExpression' && containerMethods.has(name) &&
          receiverName && !['Object', 'Reflect', 'Array'].includes(receiverName)) {
        add('container-storage', 'container-write', node, receiverName + '.' + name);
        const container = bindingId(receiver);
        const values = name === 'set' ? node.arguments.slice(1, 2) : node.arguments;
        const key = name === 'set' ? literalKey(node.arguments[0]) : null;
        for (const value of values) {
          const stored = value.type === 'Identifier' ? bindingId(value) :
            isFunction(value) ? 'function@' + value.loc.start.line : null;
          if (stored) {
            addEdge(stored, container, isFunction(value) ? 'container-store-callback' : 'container-store', node, name);
            containerWrites.push({container, key, stored, node});
          } else if (['ObjectExpression', 'ArrayExpression'].includes(value.type)) {
            const before = flowEdges.length;
            addContainedReferences(value, container, 'container-store', node);
            for (const edge of flowEdges.slice(before)) containerWrites.push({container, key, stored:edge.from, node});
          }
        }
      }
      if (node.type === 'CallExpression' && name === 'get' && receiverName) {
        const assigned = parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier'
          ? bindingId(parent.id) : null;
        addEdge(bindingId(receiver), assigned, 'container-read', node, receiverName + '.get');
        containerReads.push({container:bindingId(receiver),key:literalKey(node.arguments[0]),assigned,node});
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const calledVariable = variableForNode.get(node.callee);
        const namedFunctions = functionDeclarationsByName.get(node.callee.name) || [];
        const calledFunction = (calledVariable && functionVariables.get(calledVariable)) ||
          (namedFunctions.length === 1 ? namedFunctions[0] : null);
        if (calledFunction) {
          for (let index = 0; index < Math.min(node.arguments.length, calledFunction.params.length); index++) {
            const argument = node.arguments[index];
            const parameter = calledFunction.params[index];
            if (argument.type === 'Identifier' && parameter.type === 'Identifier') {
              addEdge(bindingId(argument), bindingId(parameter), 'function-argument', node, node.callee.name);
            } else if (isFunction(argument) && parameter.type === 'Identifier') {
              addEdge('function@' + argument.loc.start.line, bindingId(parameter),
                'function-callback-parameter', node, node.callee.name);
            }
          }
          const assigned = parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier'
            ? bindingId(parent.id) : null;
          if (assigned) {
            for (const returned of returnedValues(calledFunction)) {
              const before = flowEdges.length;
              addContainedReferences(returned, assigned, 'function-return', node);
              if (returned.type === 'Identifier' && flowEdges.length === before) {
                addEdge(bindingId(returned), assigned, 'function-return', node, node.callee.name);
              }
            }
          }
        }
      }

      if (node.type === 'CallExpression' && ['assign', 'defineProperty', 'defineProperties'].includes(name) &&
          receiverName === 'Object') {
        add('mutation', 'object-mutation-api', node, 'Object.' + name);
      }

      if (node.type === 'CallExpression' &&
          (['call', 'apply', 'bind'].includes(name) ||
           (receiverName === 'Reflect' && ['apply', 'construct'].includes(name)))) {
        add('indirect-methods', 'indirect-invocation', node,
          receiverName === 'Reflect' ? 'Reflect.' + name : 'Function.prototype.' + name);
      }
      if (node.type === 'CallExpression' && name === 'assign' && receiverName === 'Object') {
        const target = node.arguments[0] && node.arguments[0].type === 'Identifier'
          ? bindingId(node.arguments[0]) : null;
        for (const source of node.arguments.slice(1)) {
          if (source.type === 'Identifier') addEdge(bindingId(source), target,
            'object-assign-merge', node, 'Object.assign');
        }
      }
      if (node.type === 'CallExpression' && name === 'set' && receiverName === 'Reflect') {
        const target = node.arguments[0] && node.arguments[0].type === 'Identifier'
          ? bindingId(node.arguments[0]) : null;
        const value = node.arguments[2] && node.arguments[2].type === 'Identifier'
          ? bindingId(node.arguments[2]) : null;
        addEdge(value, target, 'reflective-mutation', node, 'Reflect.set');
      }
    }

    if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
      const object = bindingId(node.object), property = propertyKey(node.property);
      propertyReads.push({
        object, property,
        assigned: parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier'
          ? bindingId(parent.id) : null,
        node
      });
    }

    if (node.type === 'VariableDeclarator') {
      if (node.init && ['ObjectExpression', 'ArrayExpression'].includes(node.init.type)) {
        add('object-wrapping', 'aggregate-wrapper', node,
          node.init.type + ' may retain nested function/object identities');
        const container = bindingId(node.id);
        addContainedReferences(node.init, container, 'object-wrap', node);
        addObjectPropertySlots(node.init, container);
        if (node.init.type === 'ArrayExpression') {
          for (const element of node.init.elements) {
            if (element && isFunction(element)) add('callbacks', 'callback-stored-in-array', element, 'array element');
          }
        }
      }
      if (node.init && node.init.type === 'NewExpression' &&
          node.init.callee.type === 'Identifier' &&
          ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(node.init.callee.name)) {
        add('container-storage', 'container-construction', node, node.init.callee.name);
      }
      if (node.init && node.init.type === 'MemberExpression' &&
          node.init.object.type === 'Identifier') {
        add('indirect-methods', 'method-value-alias', node,
          (node.init.object.name + '.' + (propertyName(node.init) || '[computed]')) +
          ' stored as ' + (node.id.name || 'destructured binding'));
        addEdge(bindingId(node.init.object), bindingId(node.id),
          'indirect-method-alias', node, propertyName(node.init) || 'computed method');
      }
      if (node.id.type === 'ObjectPattern' && node.init) {
        add('indirect-methods', 'destructured-property-alias', node,
          'destructuring may retain method references');
      }
      if (node.init && node.init.type === 'Identifier' && node.id.type === 'Identifier') {
        add('object-wrapping', 'identifier-alias', node, node.init.name + ' -> ' + node.id.name);
        addEdge(bindingId(node.init), bindingId(node.id), 'identifier-alias', node, node.init.name + ' -> ' + node.id.name);
      }
    }

    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
      add('mutation', 'member-assignment', node, propertyName(node.left) || 'computed property');
      if (node.left.object.type === 'Identifier') {
        const object = bindingId(node.left.object), property = propertyKey(node.left.property);
        if (property !== null) {
          const slot = propertySlot(object, property);
          const before = flowEdges.length;
          addContainedReferences(node.right, slot, 'property-store', node);
          for (const edge of flowEdges.slice(before)) propertyWrites.push({object, property, stored:edge.from});
        }
      }
      if (node.left.object.type === 'Identifier' && node.right.type === 'Identifier') {
        addEdge(bindingId(node.right), bindingId(node.left.object), 'mutation-store', node,
          propertyName(node.left) || 'computed property');
      }
      if (node.right && (isFunction(node.right) || node.right.type === 'Identifier')) {
        add('object-wrapping', 'property-stored-value', node, 'assigned value retained by object property');
      }
      if (node.left.computed) add('custom-runtime-dispatch', 'computed-property-write', node,
        'computed writes can populate dispatch registries');
    }

    if (node.type === 'UpdateExpression' && node.argument.type === 'MemberExpression') {
      add('mutation', 'member-update', node, propertyName(node.argument) || 'computed property');
    }
    if (node.type === 'UnaryExpression' && node.operator === 'delete' &&
        node.argument.type === 'MemberExpression') {
      add('mutation', 'member-delete', node, propertyName(node.argument) || 'computed property');
    }
    if (node.type === 'MemberExpression' && node.computed &&
        !(node.property.type === 'Literal' || (node.property.type === 'TemplateLiteral' && !node.property.expressions.length))) {
      add('custom-runtime-dispatch', 'dynamic-member-lookup', node,
        (node.object.type === 'Identifier' ? node.object.name : node.object.type) + '[dynamic]');
    }
    if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      add('reflection', 'enumerated-object-keys', node, node.type);
    }
    if (node.type === 'SpreadElement' && node.argument.type === 'Identifier') {
      add('reflection', 'spread-enumeration', node, 'spread of ' + node.argument.name);
    }
    if (node.type === 'ReturnStatement' && node.argument &&
        ['Identifier', 'ObjectExpression', 'ArrayExpression', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.argument.type)) {
      add('object-wrapping', 'returned-reference', node, node.argument.type);
    }
    if (node.type === 'Property' && node.value && isFunction(node.value)) {
      add('callbacks', 'function-in-object-property', node, propertyName({type:'MemberExpression',computed:node.computed,property:node.key}) || 'object method');
    }
    if (node.type === 'SwitchStatement' && node.discriminant.type === 'MemberExpression') {
      add('custom-runtime-dispatch', 'switch-based-dispatch', node, propertyName(node.discriminant) || 'computed discriminant');
    }
    if (node.type === 'WithStatement') {
      add('reflection', 'with-scope-dynamic-resolution', node, 'with changes identifier resolution');
    }
    if (node.type === 'MetaProperty' && node.meta.name === 'new' && node.property.name === 'target') {
      add('proxies', 'proxy-new-target', node, 'new.target observed');
    }
    if (node.type === 'MemberExpression' && !node.computed &&
        node.object.type === 'ThisExpression' && node.property.name === '__proto__') {
      add('prototype-mutation', 'legacy-prototype-access', node, 'this.__proto__');
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
        node.left.property && node.left.property.name === '__proto__') {
      add('prototype-mutation', 'legacy-prototype-assignment', node, '__proto__ assignment');
    }
    if (node.type === 'ClassDeclaration' && node.superClass) {
      add('prototype-mutation', 'class-extends', node, 'class inheritance');
    }
  });

  // Resolve static object-property writes to subsequent property reads.
  // Unknown computed reads conservatively retain every stored value on the object.
  for (const read of propertyReads) {
    const matches = propertyWrites.filter(write =>
      write.object === read.object &&
      (read.property === null || write.property === read.property || write.property.startsWith(read.property + '.')));
    const destination = read.assigned || 'property-read@' + read.node.loc.start.line;
    for (const write of matches) {
      addEdge(write.stored, destination, 'property-value-read', read.node,
        read.property === null ? 'dynamic property read' : 'property=' + read.property);
    }
  }

  // Resolve container reads against all statically observed writes. A
  // literal Map key narrows the edge; unknown keys conservatively include every
  // stored value so a dynamic lookup cannot hide a live callback/object.
  for (const read of containerReads) {
    for (const write of containerWrites) {
      if (write.container !== read.container) continue;
      if (read.key !== null && write.key !== null && read.key !== write.key) continue;
      addEdge(write.stored, read.assigned, 'container-value-read', read.node,
        read.key === null ? 'dynamic container key' : 'key=' + read.key);
    }
  }

  // Captured closure records above may include the same captured binding in
  // multiple nested scopes. Deduplicate exact evidence for stable CI output.
  const unique = [...new Map(findings.map(item => [
    [item.category, item.kind, item.file, item.line, item.column, item.detail].join('|'), item
  ])).values()];
  const uniqueEdges = [...new Map(flowEdges.map(item => [
    [item.from, item.to, item.kind, item.file, item.line, item.detail].join('|'), item
  ])).values()];
  return {
    file: path.relative(root, file).split(path.sep).join('/'),
    functions: functionNodes.length, findings: unique, flowEdges: uniqueEdges
  };
}

function analyze(root = path.resolve(__dirname, '..')) {
  const files = walkFiles(root);
  const results = [];
  const parseErrors = [];
  for (const file of files) {
    try { results.push(analyzeFile(root, file)); }
    catch (error) {
      parseErrors.push({ file: path.relative(root, file).split(path.sep).join('/'), error: error.message });
    }
  }
  const findings = results.flatMap(result => result.findings);
  const flowEdges = results.flatMap(result => result.flowEdges);
  const flowEdgeKinds = {};
  for (const edge of flowEdges) flowEdgeKinds[edge.kind] = (flowEdgeKinds[edge.kind] || 0) + 1;
  const counts = Object.fromEntries(CATEGORIES.map(category => [
    category, findings.filter(item => item.category === category).length
  ]));
  const byKind = {};
  for (const finding of findings) byKind[finding.kind] = (byKind[finding.kind] || 0) + 1;
  return {
    filesAnalyzed: results.length,
    filesFailedToParse: parseErrors.length,
    functionsInventoried: results.reduce((sum, result) => sum + result.functions, 0),
    findingCount: findings.length,
    flowEdgeCount: flowEdges.length,
    flowEdgeKinds,
    flowEdges,
    counts,
    byKind,
    parseErrors,
    findings
  };
}

function run(root = path.resolve(__dirname, '..')) {
  const result = analyze(root);
  console.log('Runtime-flow reachability audit (conservative inventory; not a dead-code proof)');
  console.log('JavaScript files analyzed: ' + result.filesAnalyzed);
  console.log('Files failed to parse: ' + result.filesFailedToParse);
  console.log('Functions inventoried: ' + result.functionsInventoried);
  for (const category of CATEGORIES) console.log(category + ': ' + result.counts[category]);
  console.log('Runtime-flow findings: ' + result.findingCount);
  console.log('Explicit runtime-flow edges: ' + result.flowEdgeCount);
  for (const [kind, count] of Object.entries(result.flowEdgeKinds).sort()) {
    console.log('  ' + kind + ': ' + count);
  }
  if (result.parseErrors.length) {
    for (const item of result.parseErrors) console.error(item.file + ': ' + item.error);
    process.exitCode = 1;
  }
  return result;
}

if (require.main === module) run(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
module.exports = { CATEGORIES, analyze, analyzeFile, run, walkFiles };
