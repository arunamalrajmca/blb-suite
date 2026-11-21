'use strict';

// Conservative computed-property candidate analysis. A candidate is reported only
// when its key comes from a finite literal set and its receiver has statically
// observed own properties. This is evidence for review, never a deletion proof.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const EXT = new Set(['.js', '.cjs', '.mjs']);
const SKIP = new Set(['.git', 'node_modules', 'coverage', 'dist', 'test-results', 'playwright-report']);
const MAX_VALUES = 32;

function walk(root) {
  const out = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && EXT.has(path.extname(file))) out.push(path.resolve(file));
    }
  }
  visit(root);
  return out.sort();
}
function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
function resolveModuleFile(from, spec, fileSet) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  const candidates = path.extname(base)
    ? [base]
    : [base, ...['.js', '.cjs', '.mjs'].map(ext => base + ext), ...['.js', '.cjs', '.mjs'].map(ext => path.join(base, 'index' + ext))];
  return candidates.find(candidate => fileSet.has(candidate)) || null;
}
function parse(file) {
  const source = fs.readFileSync(file, 'utf8');
  let error;
  for (const sourceType of ['script', 'module']) {
    try { return acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true, ranges: true }); }
    catch (caught) { error = caught; }
  }
  throw error;
}
function visit(node, fn, parent = null) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'range'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => visit(child, fn, node));
    else if (value && typeof value.type === 'string') visit(value, fn, node);
  }
}
function bindingsFor(ast) {
  const manager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: ast.sourceType || 'script', optimistic: false, ignoreEval: false });
  const result = new Map();
  for (const scope of manager.scopes) {
    for (const variable of scope.variables || []) {
      const first = variable.identifiers && variable.identifiers[0];
      const key = variable.name + '@' + (first?.loc?.start.line || 0) + ':' + (first?.loc?.start.column || 0);
      for (const id of variable.identifiers || []) result.set(id, key);
      for (const def of variable.defs || []) if (def.name) result.set(def.name, key);
    }
    for (const ref of scope.references || []) if (ref.resolved) {
      const first = ref.resolved.identifiers && ref.resolved.identifiers[0];
      result.set(ref.identifier, ref.resolved.name + '@' + (first?.loc?.start.line || 0) + ':' + (first?.loc?.start.column || 0));
    }
  }
  return result;
}
function unionInto(map, key, values) {
  if (!key || !values || !values.size || values.size > MAX_VALUES) return false;
  const prior = map.get(key) || new Set();
  const next = new Set([...prior, ...values]);
  if (next.size > MAX_VALUES || next.size === prior.size && [...next].every(value => prior.has(value))) return false;
  map.set(key, next);
  return true;
}
function valuesOf(node, env, bindings, depth = 0) {
  if (!node || depth > 10) return null;
  if (node.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) return new Set([String(node.value)]);
  if (node.type === 'Identifier') return env.get(bindings.get(node)) || null;
  if (node.type === 'TemplateLiteral') {
    if (!node.expressions.length) return new Set([node.quasis[0].value.cooked]);
    return null;
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const left = valuesOf(node.consequent || node.left, env, bindings, depth + 1);
    const right = valuesOf(node.alternate || node.right, env, bindings, depth + 1);
    if (!left || !right || left.size + right.size > MAX_VALUES) return null;
    return new Set([...left, ...right]);
  }
  if (node.type === 'SequenceExpression') return valuesOf(node.expressions[node.expressions.length - 1], env, bindings, depth + 1);
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = valuesOf(node.left, env, bindings, depth + 1);
    const right = valuesOf(node.right, env, bindings, depth + 1);
    if (!left || !right || left.size * right.size > MAX_VALUES) return null;
    return new Set([...left].flatMap(a => [...right].map(b => a + b)));
  }
  return null;
}
function unwrap(node) {
  while (node && ['AwaitExpression','ChainExpression','ParenthesizedExpression'].includes(node.type)) node = node.argument || node.expression;
  return node;
}
function memberPath(node) {
  const parts = [];
  while (node && node.type === 'MemberExpression' && !node.computed) {
    parts.unshift(node.property.name);
    node = node.object;
  }
  if (node && node.type === 'Identifier') parts.unshift(node.name);
  return parts.join('.');
}
function isArrayProducer(node) {
  node = unwrap(node);
  if (!node) return false;
  if (node.type === 'ArrayExpression') return true;
  if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Array') return true;
  if (node.type !== 'CallExpression') return false;
  const path = memberPath(node.callee);
  return path === 'Array.from' || path === 'Object.keys' || path === 'Object.values' ||
    path === 'Object.entries' || path === 'Promise.all' ||
    (node.callee.type === 'MemberExpression' && ['split','match','map','filter','flatMap','slice','concat','sort','toSorted','reverse','flat'].includes(node.callee.property.name));
}
function isNumericIndexExpression(node) {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'number') return true;
  if (node.type === 'Identifier') return /(?:^|_)(?:i|idx|index|offset|chapter|verse|position|start|end|point|token|found|suffix|candidate|current|selection|word|char|byte|line|column|cursor|length|count|number|no|n)(?:$|_)/i.test(node.name);
  if (node.type === 'BinaryExpression' && ['+','-'].includes(node.operator)) {
    return isNumericIndexExpression(node.left) || isNumericIndexExpression(node.right) ||
      node.left.type === 'Literal' && typeof node.left.value === 'number' ||
      node.right.type === 'Literal' && typeof node.right.value === 'number';
  }
  return false;
}
function analyze(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  const files = walk(root), records = new Map(), parseErrors = [];
  for (const file of files) {
    try {
      const ast = parse(file);
      records.set(file, { ast, bindings: bindingsFor(ast), env: new Map(), owners: new Map(), aliases: new Map(), definitions: new Map(), arrays: new Set(), storageMaps: new Map(), storageResults: new Set() });
    } catch (error) { parseErrors.push({ file: rel(root, file), error: error.message }); }
  }

  // Summarize functions that return a property read from chrome.storage.local.
  const storageReturnFields = new Map();
  for (const record of records.values()) {
    const { ast, bindings } = record;
    visit(ast, node => {
      if (node.type !== 'FunctionDeclaration' || !node.id) return;
      const storageBindings = new Set();
      visit(node.body, child => {
        if (child.type !== 'VariableDeclarator' || child.id.type !== 'Identifier') return;
        const init = unwrap(child.init);
        if (init?.type === 'CallExpression' && memberPath(init.callee) === 'chrome.storage.local.get') {
          storageBindings.add(bindings.get(child.id));
        }
      });
      if (!storageBindings.size) return;
      visit(node.body, child => {
        if (child.type !== 'ReturnStatement' || !child.argument) return;
        visit(child.argument, member => {
          if (member.type === 'MemberExpression' && !member.computed && member.object.type === 'Identifier' &&
              storageBindings.has(bindings.get(member.object))) {
            storageReturnFields.set(node.id.name, member.property.name);
          }
        });
      });
    });
  }

  // First collect bounded constants, object/class owners, aliases, and local functions.
  for (const [file, record] of records) {
    const { ast, bindings, env, owners, aliases, definitions, arrays, storageMaps, storageResults } = record;
    visit(ast, (node, parent) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        const key = bindings.get(node.id);
        if (key && node.init) {
          definitions.set(key, node.init);
          if (isArrayProducer(node.init)) arrays.add(key);
          const init = unwrap(node.init);
          if (init?.type === 'CallExpression' && memberPath(init.callee) === 'chrome.storage.local.get') storageResults.add(key);
          for (const storageBinding of storageResults) {
            let field = null;
            visit(node.init, child => {
              if (!field && child.type === 'MemberExpression' && !child.computed && child.object.type === 'Identifier' &&
                  bindings.get(child.object) === storageBinding) field = child.property.name;
            });
            if (field) storageMaps.set(key, field);
          }
          if (init?.type === 'CallExpression' && init.callee.type === 'Identifier' && storageReturnFields.has(init.callee.name)) {
            storageMaps.set(key, storageReturnFields.get(init.callee.name));
          }
          const values = valuesOf(node.init, env, bindings);
          if (values) {
            unionInto(env, key, values);
          }
          if (node.init.type === 'Identifier') {
            const source = bindings.get(node.init);
            if (source) {
              aliases.set(key, source);
              if (arrays.has(source)) arrays.add(key);
              if (storageMaps.has(source)) storageMaps.set(key, storageMaps.get(source));
            }
          }
          if (node.init.type === 'NewExpression' && node.init.callee.type === 'Identifier') {
            const source = bindings.get(node.init.callee);
            if (source) aliases.set(key, source);
          }
          if (node.init.type === 'ObjectExpression') {
            const props = new Set();
            for (const property of node.init.properties) {
              if (property.type === 'SpreadElement') continue;
              const name = property.computed ? valuesOf(property.key, env, bindings) : new Set([String(property.key.name ?? property.key.value)]);
              if (name) for (const value of name) props.add(value);
            }
            owners.set(key, props);
          }
          if (node.init.type === 'ClassExpression') {
            const props = new Set(node.init.body.body.filter(item => item.key).map(item => item.computed ? null : String(item.key.name ?? item.key.value)).filter(Boolean));
            owners.set(key, props);
          }
        }
      }
      if (node.type === 'ClassDeclaration' && node.id) {
        const key = bindings.get(node.id);
        if (key) owners.set(key, new Set(node.body.body.filter(item => item.key && !item.computed).map(item => String(item.key.name ?? item.key.value))));
      }
      if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') {
        const key = bindings.get(node.left), values = valuesOf(node.right, env, bindings);
        if (key && isArrayProducer(node.right)) arrays.add(key);
        if (key && values) unionInto(env, key, values);
        if (key && node.right.type === 'Identifier') {
          const source = bindings.get(node.right); if (source) aliases.set(key, source);
        }
      }
    });

    // Iterate aliases and simple assignments to a fixed point (bounded by file size).
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const [alias, source] of aliases) {
        changed = unionInto(env, alias, env.get(source)) || changed;
        if (arrays.has(source)) arrays.add(alias);
        if (storageMaps.has(source) && !storageMaps.has(alias)) storageMaps.set(alias, storageMaps.get(source));
      }
      visit(ast, node => {
        if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') {
          const key = bindings.get(node.left), values = valuesOf(node.right, env, bindings);
          if (key && values) changed = unionInto(env, key, values) || changed;
        }
      });
      if (!changed) break;
    }

    // Map callback parameters back to storage containers passed by wrapper helpers.
    const callbackStorageFields = new Map();
    visit(ast, node => {
      if (node.type !== 'FunctionDeclaration' || !node.id) return;
      node.params.forEach((param, index) => {
        if (param.type !== 'Identifier') return;
        visit(node.body, call => {
          if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== param.name) return;
          for (const argument of call.arguments || []) {
            if (argument.type !== 'Identifier') continue;
            const binding = bindings.get(argument);
            const init = definitions.get(binding);
            const unwrapped = unwrap(init);
            if (unwrapped?.type === 'CallExpression' && unwrapped.callee.type === 'Identifier' &&
                storageReturnFields.has(unwrapped.callee.name)) {
              callbackStorageFields.set(node.id.name + ':' + index, storageReturnFields.get(unwrapped.callee.name));
            }
          }
        });
      });
    });
    visit(ast, call => {
      if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return;
      const callbackIndex = 0;
      const field = callbackStorageFields.get(call.callee.name + ':' + callbackIndex);
      const callback = call.arguments?.[callbackIndex];
      if (!field || !callback || !['ArrowFunctionExpression','FunctionExpression'].includes(callback.type)) return;
      const parameter = callback.params?.[0];
      if (parameter?.type === 'Identifier') {
        const binding = bindings.get(parameter);
        if (binding) storageMaps.set(binding, field);
      }
    });

    // Add prototype-assigned methods to the owning class constructor.
    visit(ast, node => {
      if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression') return;
      const left = node.left;
      if (left.object.type === 'MemberExpression' && left.object.object.type === 'Identifier' &&
          !left.object.computed && left.object.property.name === 'prototype') {
        const owner = bindings.get(left.object.object);
        const property = left.computed ? valuesOf(left.property, env, bindings) : new Set([String(left.property.name)]);
        if (owner && property) {
          if (!owners.has(owner)) owners.set(owner, new Set());
          for (const value of property) owners.get(owner).add(value);
        }
      }
    });
  }

  // Resolve exported object identity and constant values into importing modules.
  // Re-exports are followed conservatively, with cycle protection.
  const exportsByFile = new Map(), reexportsByFile = new Map(), exportAllByFile = new Map();
  const fileSet = new Set(records.keys());
  for (const [file, record] of records) {
    const { ast, bindings, env, owners } = record;
    const exported = new Map(), reexports = new Map(), exportAll = [];
    for (const statement of ast.body) {
      if (statement.type === 'ExportNamedDeclaration') {
        const declaration = statement.declaration;
        if (declaration && declaration.type === 'VariableDeclaration') {
          for (const item of declaration.declarations || []) {
            if (item.id.type !== 'Identifier') continue;
            const key = bindings.get(item.id);
            if (key) exported.set(item.id.name, { key });
          }
        } else if (declaration && ['FunctionDeclaration', 'ClassDeclaration'].includes(declaration.type) && declaration.id) {
          const key = bindings.get(declaration.id);
          if (key) exported.set(declaration.id.name, { key });
        }
        if (statement.source) {
          const target = resolveModuleFile(file, statement.source.value, fileSet);
          if (target) for (const specifier of statement.specifiers || []) {
            const importedName = specifier.local.name || specifier.local.value;
            const exportedName = specifier.exported.name || specifier.exported.value;
            reexports.set(exportedName, { file: target, name: importedName });
          }
        } else {
          for (const specifier of statement.specifiers || []) {
            const localKey = bindings.get(specifier.local);
            const exportedName = specifier.exported.name || specifier.exported.value;
            if (localKey) exported.set(exportedName, { key: localKey });
          }
        }
      } else if (statement.type === 'ExportDefaultDeclaration') {
        const declaration = statement.declaration;
        if (declaration.type === 'Identifier') {
          const key = bindings.get(declaration);
          if (key) exported.set('default', { key });
        } else if (declaration.type === 'ObjectExpression') {
          const props = new Set();
          for (const property of declaration.properties) {
            if (property.type === 'SpreadElement') continue;
            const names = property.computed ? valuesOf(property.key, env, bindings) : new Set([String(property.key.name ?? property.key.value)]);
            if (names) for (const name of names) props.add(name);
          }
          exported.set('default', { ownerProps: props });
        } else if (declaration.type === 'ClassDeclaration' && declaration.id) {
          const key = bindings.get(declaration.id);
          if (key) exported.set('default', { key });
        }
      } else if (statement.type === 'ExportAllDeclaration' && statement.source) {
        const target = resolveModuleFile(file, statement.source.value, fileSet);
        if (target) exportAll.push(target);
      }
    }
    exportsByFile.set(file, exported);
    reexportsByFile.set(file, reexports);
    exportAllByFile.set(file, exportAll);
  }

  function resolveExport(file, name, seen = new Set()) {
    const marker = file + '::' + name;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const direct = exportsByFile.get(file)?.get(name);
    if (direct) return { file, ...direct };
    const reexport = reexportsByFile.get(file)?.get(name);
    if (reexport) return resolveExport(reexport.file, reexport.name, seen);
    if (name !== 'default') {
      for (const target of exportAllByFile.get(file) || []) {
        const resolved = resolveExport(target, name, seen);
        if (resolved) return resolved;
      }
    }
    return null;
  }

  // Iterate a few times so chains of imports/re-exports can inherit owner and
  // constant evidence regardless of file traversal order.
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [file, record] of records) {
      const { ast, bindings, env, owners } = record;
      visit(ast, node => {
        if (node.type !== 'ImportDeclaration') return;
        const target = resolveModuleFile(file, node.source.value, fileSet);
        if (!target) return;
        for (const specifier of node.specifiers || []) {
          if (specifier.type === 'ImportNamespaceSpecifier') continue;
          const importedName = specifier.type === 'ImportDefaultSpecifier'
            ? 'default' : (specifier.imported.name || specifier.imported.value);
          const localKey = bindings.get(specifier.local);
          if (!localKey) continue;
          const resolved = resolveExport(target, importedName);
          if (!resolved) continue;
          if (resolved.key) {
            const sourceRecord = records.get(resolved.file);
            if (sourceRecord) {
              changed = unionInto(env, localKey, sourceRecord.env.get(resolved.key)) || changed;
              const props = sourceRecord.owners.get(resolved.key);
              if (props && props.size) {
                if (!owners.has(localKey)) owners.set(localKey, new Set());
                const before = owners.get(localKey).size;
                for (const prop of props) owners.get(localKey).add(prop);
                if (owners.get(localKey).size !== before) changed = true;
              }
            }
          }
          if (resolved.ownerProps && resolved.ownerProps.size) {
            if (!owners.has(localKey)) owners.set(localKey, new Set());
            const before = owners.get(localKey).size;
            for (const prop of resolved.ownerProps) owners.get(localKey).add(prop);
            if (owners.get(localKey).size !== before) changed = true;
          }
        }
      });
    }
    if (!changed) break;
  }

  const observations = [];
  const globalObjectProperties = new Map();
  for (const record of records.values()) {
    visit(record.ast, node => {
      if (node.type !== 'AssignmentExpression' || node.operator !== '=' || node.left.type !== 'MemberExpression' ||
          node.left.computed || node.left.object.type !== 'Identifier' || node.left.object.name !== 'globalThis' ||
          node.right.type !== 'CallExpression' || node.right.callee.type !== 'MemberExpression' ||
          node.right.callee.object.type !== 'Identifier' || node.right.callee.object.name !== 'Object' ||
          node.right.callee.property.name !== 'freeze' || node.right.arguments[0]?.type !== 'ObjectExpression') return;
      globalObjectProperties.set(node.left.property.name, new Set(node.right.arguments[0].properties
        .filter(property => property.type !== 'SpreadElement')
        .map(property => String(property.key.name ?? property.key.value))));
    });
  }
  for (const [file, record] of records) {
    const sourceText = fs.readFileSync(file, 'utf8');
    const { ast, bindings, env, aliases, owners, definitions, arrays, storageMaps } = record;
    const canonicalOwner = key => {
      const seen = new Set();
      while (key && aliases.has(key) && !seen.has(key)) { seen.add(key); key = aliases.get(key); }
      return key;
    };
    visit(ast, (node, parent) => {
      if (node.type !== 'MemberExpression' || !node.computed) return;
      const keys = valuesOf(node.property, env, bindings);
      if (keys && keys.size) return; // already statically bounded
      const receiverBinding = node.object.type === 'Identifier' ? bindings.get(node.object) : null;
      const receiver = receiverBinding ? canonicalOwner(receiverBinding) : null;
      const inlineObjectProperties = node.object.type === 'ObjectExpression'
        ? node.object.properties.filter(property => property.type !== 'SpreadElement').flatMap(property =>
            property.computed ? [...(valuesOf(property.key, env, bindings) || [])] : [String(property.key.name ?? property.key.value)])
        : [];
      const globalOwner = node.object.type === 'MemberExpression' && node.object.object.type === 'Identifier' &&
        node.object.object.name === 'globalThis' && !node.object.computed
        ? globalObjectProperties.get(node.object.property.name) : null;
      const known = receiver && owners.get(receiver) ? [...owners.get(receiver)].sort() :
        inlineObjectProperties.length ? [...new Set(inlineObjectProperties)].sort() :
        globalOwner ? [...globalOwner].sort() : [];
      const keyBinding = node.property.type === 'Identifier' ? bindings.get(node.property) : null;
      const keyDefinition = keyBinding && definitions.has(keyBinding)
        ? sourceText.slice(definitions.get(keyBinding).start, definitions.get(keyBinding).end).slice(0, 180)
        : keyBinding ? 'parameter-or-loop-binding' : '';
      const receiverKind = receiver && storageMaps.has(receiver) ? 'storage-backed-container' :
        receiver && arrays.has(receiver) || node.object.type === 'MemberExpression' && node.object.property.name === 'verses'
          ? 'array-like' :
        inlineObjectProperties.length || globalOwner || receiver && owners.has(receiver) ? 'object-like' :
        isNumericIndexExpression(node.property) ? 'numeric-index-candidate' : 'unknown';
      const storageField = receiver && storageMaps.has(receiver) ? storageMaps.get(receiver) : '';
      const role = parent && parent.type === 'CallExpression' && parent.callee === node ? 'call' :
        parent && parent.type === 'NewExpression' && parent.callee === node ? 'construct' :
        parent && parent.type === 'AssignmentExpression' && parent.left === node ? 'write' :
        parent && parent.type === 'UpdateExpression' && parent.argument === node ? 'update' : 'read-or-other';
      observations.push({
        file: rel(root, file), line: node.loc.start.line,
        expression: fs.readFileSync(file, 'utf8').slice(node.start, node.end).slice(0, 200),
        propertyExpression: fs.readFileSync(file, 'utf8').slice(node.property.start, node.property.end).slice(0, 100),
        receiverExpression: sourceText.slice(node.object.start, node.object.end).slice(0, 120),
        receiverBinding, receiverKind, storageField, keyBinding, keyDefinition, keyValues: keys ? [...keys] : [],
        valueExpression: parent?.type === 'AssignmentExpression' && parent.left === node
          ? sourceText.slice(parent.right.start, parent.right.end).slice(0, 160) : '',
        role, receiverKnown: Boolean(receiver && owners.has(receiver)),
        candidateProperties: known, candidateCount: known.length,
        status: known.length ? 'receiver-properties-known-key-unknown' : 'receiver-or-key-unknown'
      });
    });
  }
  const byStatus = {}, byRole = {}, byReceiverKind = {}, withCandidates = observations.filter(item => item.candidateCount);
  for (const item of observations) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    byRole[item.role] = (byRole[item.role] || 0) + 1;
    byReceiverKind[item.receiverKind] = (byReceiverKind[item.receiverKind] || 0) + 1;
  }
  return { filesAnalyzed: records.size, parseErrors, observations, summary: {
    total: observations.length, withReceiverCandidates: withCandidates.length,
    byStatus, byRole, byReceiverKind,
    storageBackedAccesses: observations.filter(item => item.receiverKind === 'storage-backed-container').length,
    candidatePropertyTotal: withCandidates.reduce((sum, item) => sum + item.candidateCount, 0)
  } };
}
function run(root) {
  const result = analyze(root);
  console.log('Computed-property candidate audit (review evidence only; not a dead-code proof)');
  console.log('Files analyzed: ' + result.filesAnalyzed);
  console.log('Parse errors: ' + result.parseErrors.length);
  console.log('Computed-property observations: ' + result.summary.total);
  console.log('Observations with known receiver property candidates: ' + result.summary.withReceiverCandidates);
  console.log('Observations by status: ' + JSON.stringify(result.summary.byStatus));
  console.log('Observations by access role: ' + JSON.stringify(result.summary.byRole));
  console.log('Observations by receiver kind: ' + JSON.stringify(result.summary.byReceiverKind));
  console.log('Storage-backed container accesses: ' + result.summary.storageBackedAccesses);
  console.log('Candidate property references (not proof of runtime selection): ' + result.summary.candidatePropertyTotal);
  console.log('Candidate observations: ' + JSON.stringify(result.observations.filter(item => item.candidateCount)));
  const focusFiles = new Set(['extension/background.js', 'extension/content.js']);
  console.log('Background/content unresolved computed-property observations: ' + JSON.stringify(
    result.observations.filter(item => focusFiles.has(item.file))
  ));
  for (const error of result.parseErrors) console.error(error.file + ': ' + error.error);
  if (result.parseErrors.length) process.exitCode = 1;
  return result;
}
if (require.main === module) run(process.argv[2]);
module.exports = { analyze, run, valuesOf };
