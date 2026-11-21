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
function parse(file) {
  const source = fs.readFileSync(file, 'utf8');
  let error;
  for (const sourceType of ['script', 'module']) {
    try { return acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true }); }
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
function analyze(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  const files = walk(root), records = new Map(), parseErrors = [];
  for (const file of files) {
    try {
      const ast = parse(file);
      records.set(file, { ast, bindings: bindingsFor(ast), env: new Map(), owners: new Map(), aliases: new Map(), functions: new Map() });
    } catch (error) { parseErrors.push({ file: rel(root, file), error: error.message }); }
  }

  // First collect bounded constants, object/class owners, aliases, and local functions.
  for (const [file, record] of records) {
    const { ast, bindings, env, owners, aliases, functions } = record;
    visit(ast, (node, parent) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        const key = bindings.get(node.id);
        if (key && node.init) {
          const values = valuesOf(node.init, env, bindings);
          if (values) {
            unionInto(env, key, values);
          }
          if (node.init.type === 'Identifier') {
            const source = bindings.get(node.init);
            if (source) aliases.set(key, source);
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
        if (key && values) unionInto(env, key, values);
        if (key && node.right.type === 'Identifier') {
          const source = bindings.get(node.right); if (source) aliases.set(key, source);
        }
      }
    });

    // Iterate aliases and simple assignments to a fixed point (bounded by file size).
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const [alias, source] of aliases) changed = unionInto(env, alias, env.get(source)) || changed;
      visit(ast, node => {
        if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') {
          const key = bindings.get(node.left), values = valuesOf(node.right, env, bindings);
          if (key && values) changed = unionInto(env, key, values) || changed;
        }
      });
      if (!changed) break;
    }

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

  const observations = [];
  for (const [file, record] of records) {
    const { ast, bindings, env, aliases, owners } = record;
    const canonicalOwner = key => {
      const seen = new Set();
      while (key && aliases.has(key) && !seen.has(key)) { seen.add(key); key = aliases.get(key); }
      return key;
    };
    visit(ast, (node, parent) => {
      if (node.type !== 'MemberExpression' || !node.computed) return;
      const keys = valuesOf(node.property, env, bindings);
      if (keys && keys.size) return; // already statically bounded
      const receiver = node.object.type === 'Identifier' ? canonicalOwner(bindings.get(node.object)) : null;
      const known = receiver && owners.get(receiver) ? [...owners.get(receiver)].sort() : [];
      const role = parent && parent.type === 'CallExpression' && parent.callee === node ? 'call' :
        parent && parent.type === 'NewExpression' && parent.callee === node ? 'construct' :
        parent && parent.type === 'AssignmentExpression' && parent.left === node ? 'write' :
        parent && parent.type === 'UpdateExpression' && parent.argument === node ? 'update' : 'read-or-other';
      observations.push({
        file: rel(root, file), line: node.loc.start.line,
        expression: fs.readFileSync(file, 'utf8').slice(node.start, node.end).slice(0, 200),
        propertyExpression: fs.readFileSync(file, 'utf8').slice(node.property.start, node.property.end).slice(0, 100),
        role, receiverKnown: Boolean(receiver && owners.has(receiver)),
        candidateProperties: known, candidateCount: known.length,
        status: known.length ? 'receiver-properties-known-key-unknown' : 'receiver-or-key-unknown'
      });
    });
  }
  const byStatus = {}, byRole = {}, withCandidates = observations.filter(item => item.candidateCount);
  for (const item of observations) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    byRole[item.role] = (byRole[item.role] || 0) + 1;
  }
  return { filesAnalyzed: records.size, parseErrors, observations, summary: {
    total: observations.length, withReceiverCandidates: withCandidates.length,
    byStatus, byRole, candidatePropertyTotal: withCandidates.reduce((sum, item) => sum + item.candidateCount, 0)
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
  console.log('Candidate property references (not proof of runtime selection): ' + result.summary.candidatePropertyTotal);
  console.log('Candidate observations: ' + JSON.stringify(result.observations.filter(item => item.candidateCount)));
  for (const error of result.parseErrors) console.error(error.file + ': ' + error.error);
  if (result.parseErrors.length) process.exitCode = 1;
  return result;
}
if (require.main === module) run(process.argv[2]);
module.exports = { analyze, run, valuesOf };
