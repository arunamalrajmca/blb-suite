'use strict';

// Conservative metaprogramming/callback uncertainty census.
// Findings are evidence of analysis boundaries, never dead-code or reachability proofs.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const SKIP = new Set(['.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist']);
const EXT = new Set(['.js', '.cjs', '.mjs']);
function walk(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && EXT.has(path.extname(file))) files.push(file);
    }
  }
  visit(root);
  return files.sort();
}
function parse(file) {
  const source = fs.readFileSync(file, 'utf8');
  let error;
  for (const sourceType of ['script', 'module']) {
    try { return acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true, ranges: true, allowHashBang: true }); }
    catch (caught) { error = caught; }
  }
  throw new Error(path.relative(process.cwd(), file) + ': ' + error.message);
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
function unresolvedReferences(ast) {
  const manager = eslintScope.analyze(structuredClone(ast), {
    ecmaVersion: 2022,
    sourceType: ast.sourceType || 'script',
    optimistic: false,
    ignoreEval: false
  });
  const unresolved = new Set();
  for (const scope of manager.scopes) {
    for (const reference of scope.references || []) {
      if (!reference.resolved) unresolved.add(reference.identifier.start + ':' + reference.identifier.end);
    }
  }
  return unresolved;
}
function needsScopeAnalysis(ast) {
  let needed = false;
  const descriptorMethods = new Set([
    'defineProperty', 'defineProperties', 'setPrototypeOf', 'assign', 'create',
    'freeze', 'seal', 'preventExtensions'
  ]);
  visit(ast, node => {
    if (needed) return;
    if ((node.type === 'NewExpression' || node.type === 'CallExpression') &&
        node.callee.type === 'Identifier' &&
        ['Proxy', 'eval', 'Function'].includes(node.callee.name)) {
      needed = true;
      return;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const root = rootIdentifier(node.callee);
      const property = node.callee.computed
        ? (node.callee.property.type === 'Literal' ? String(node.callee.property.value) : null)
        : node.callee.property.name;
      if (root?.name === 'Reflect' || (root?.name === 'Object' && descriptorMethods.has(property))) {
        needed = true;
      }
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
        node.left.object.type === 'Identifier' && node.left.object.name === 'Object') {
      const property = node.left.computed
        ? (node.left.property.type === 'Literal' ? String(node.left.property.value) : null)
        : node.left.property.name;
      if (property === 'setPrototypeOf') needed = true;
    }
  });
  return needed;
}
function rootIdentifier(node) {
  while (node && node.type === 'MemberExpression') node = node.object;
  return node?.type === 'Identifier' ? node : null;
}
function memberName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  const property = node.computed
    ? (node.property.type === 'Literal' ? String(node.property.value) : null)
    : node.property.name;
  const object = node.object.type === 'Identifier' ? node.object.name :
    node.object.type === 'MemberExpression' ? memberName(node.object) : null;
  return object && property !== null ? object + '.' + property : property;
}
function keyShape(node) {
  if (!node) return 'unknown';
  if (node.type === 'Identifier') return 'identifier-derived';
  if (node.type === 'CallExpression') return 'call-generated';
  if (node.type === 'BinaryExpression' && node.operator === '+') return 'concatenated';
  if (node.type === 'TemplateLiteral' && node.expressions.length) return 'template-interpolated';
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') return 'branched';
  return 'computed-expression';
}
function analyze(root = path.resolve(__dirname, '..')) {
  const files = walk(root), observations = [], parseErrors = [];\n  let scopeAnalysisFiles = 0;
  const add = (file, node, kind, detail, certainty = 'unresolved-runtime-semantics') => observations.push({
    file: path.relative(root, file).split(path.sep).join('/'),
    line: node.loc?.start.line || null, kind, detail, certainty
  });
  for (const file of files) {
    let ast;
    try { ast = parse(file); } catch (error) { parseErrors.push({ file: path.relative(root, file), error: error.message }); continue; }
    let unresolved;
    try { unresolved = unresolvedReferences(ast); }
    catch (error) { parseErrors.push({ file: path.relative(root, file), error: 'Scope analysis failed: ' + error.message }); continue; }
    visit(ast, (node, parent) => {
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Proxy' && unresolved.has(node.callee.start + ':' + node.callee.end)) {
        const traps = node.arguments[1]?.type === 'ObjectExpression'
          ? node.arguments[1].properties.filter(p => p.type === 'Property').map(p => p.key.name || p.key.value).filter(Boolean)
          : [];
        add(file, node, 'proxy-construction', 'Proxy traps: ' + (traps.join(', ') || 'dynamic/unknown'));
      }
      if (node.type === 'ImportExpression') {
        add(file, node, 'dynamic-module-loading', 'import() target is resolved at runtime and may not be statically enumerable');
      }
      if (node.type === 'WithStatement') {
        add(file, node, 'dynamic-scope', 'with statement makes identifier/property resolution dependent on runtime object shape');
      }
      if (node.type === 'CallExpression') {
        const calleeName = node.callee.type === 'Identifier' ? node.callee.name : null;
        if (calleeName === 'eval' && unresolved.has(node.callee.start + ':' + node.callee.end)) {
          add(file, node, 'dynamic-code-generation', 'eval may execute source that is invisible to static reachability analysis');
        }
        if ((calleeName === 'Function' && unresolved.has(node.callee.start + ':' + node.callee.end)) ||
            (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'constructor')) {
          add(file, node, 'dynamic-code-generation', 'Function constructor or constructor access may create executable code dynamically');
        }
        const name = memberName(node.callee);
        if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' &&
            node.callee.object.name === 'Reflect' && unresolved.has(node.callee.object.start + ':' + node.callee.object.end)) {
          add(file, node, 'reflective-operation', 'Reflect.' + (node.callee.property.name || 'computed') + ' may bypass ordinary property-use analysis');
        }
        if (name && /^(Object|Reflect)\.(?:defineProperty|defineProperties|setPrototypeOf|assign|create|freeze|seal|preventExtensions)$/.test(name) &&
            unresolved.has(rootIdentifier(node.callee)?.start + ':' + rootIdentifier(node.callee)?.end)) {
          add(file, node, 'descriptor-or-prototype-mutation', name + ' can alter visible properties or inheritance');
        }
        const method = node.callee.type === 'MemberExpression'
          ? (node.callee.computed ? null : node.callee.property.name) : null;
        if (method && /^(?:then|catch|finally|map|flatMap|forEach|filter|reduce|some|every|sort|addEventListener|removeEventListener|on|once|subscribe|register|use|tap|pipe|watch|observe|intercept|provide|configure|setHandler|addHook)$/.test(method)) {
          for (const [index, arg] of node.arguments.entries()) {
            if (['FunctionExpression', 'ArrowFunctionExpression'].includes(arg.type) || arg.type === 'Identifier' || arg.type === 'MemberExpression') {
              add(file, arg, 'callback-contract', method + ' argument[' + index + '] has a callback-like position; framework/runtime contract may be external');
            }
          }
        }
        const relativeFile = path.relative(root, file).split(path.sep).join('/');
        const knownPlaywrightTestDeclaration = node.callee.type === 'Identifier' &&
          node.callee.name === 'test' && relativeFile.startsWith('tests/browser/') &&
          /\\.spec\\.[cm]?js$/.test(relativeFile);
        if (node.callee.type === 'Identifier' && !['require', 'import'].includes(node.callee.name) &&
            !knownPlaywrightTestDeclaration) {
          for (const [index, arg] of node.arguments.entries()) {
            if (['FunctionExpression', 'ArrowFunctionExpression'].includes(arg.type)) {
              add(file, arg, 'higher-order-callback-boundary', 'callback passed to ' + node.callee.name + ' argument[' + index + ']; callee contract is project-defined or external');
            }
          }
        }
      }
      if (node.type === 'MemberExpression' && node.computed) {
        const literal = node.property.type === 'Literal' &&
          (typeof node.property.value === 'string' || typeof node.property.value === 'number');
        if (!literal) add(file, node, 'computed-property-name', keyShape(node.property) + ' property access may resolve to runtime-generated names');
      }
      if (node.type === 'Property' && node.computed) {
        const literal = node.key.type === 'Literal' && typeof node.key.value === 'string';
        if (!literal) add(file, node, 'computed-object-key', keyShape(node.key) + ' object key may be generated at runtime');
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        const key = node.left.computed ? (node.left.property.type === 'Literal' ? String(node.left.property.value) : null) : node.left.property.name;
        if (key === '__proto__' || key === 'prototype' || (node.left.object.type === 'Identifier' && node.left.object.name === 'Object' && key === 'setPrototypeOf' && unresolved.has(node.left.object.start + ':' + node.left.object.end))) {
          add(file, node, 'prototype-mutation', 'assignment to ' + key + ' can change property lookup/inheritance');
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object' && unresolved.has(node.callee.object.start + ':' + node.callee.object.end) &&
          ['setPrototypeOf', 'defineProperty', 'defineProperties', 'assign', 'create'].includes(node.callee.property.name)) {
        add(file, node, 'prototype-or-descriptor-api', 'Object.' + node.callee.property.name + ' may change property visibility or inheritance');
      }
      if (node.type === 'ReturnStatement' && node.argument &&
          ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.argument.type)) {
        add(file, node, 'higher-order-function-factory', 'function returns another function; callback identity may be created indirectly');
      }
    });
  }
  const unique = [...new Map(observations.map(item => [JSON.stringify(item), item])).values()];
  const byKind = {};
  for (const item of unique) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  return { filesScanned: files.length, scopeAnalysisFiles, observations: unique, parseErrors, summary: { total: unique.length, byKind } };
}
function run(root) {
  const result = analyze(root);
  console.log('Runtime metaprogramming and callback uncertainty census (not dead-code proof)');
  console.log('Files scanned: ' + result.filesScanned);\n  console.log('Files requiring global-shadow scope analysis: ' + result.scopeAnalysisFiles);
  console.log('Uncertainty observations: ' + result.summary.total);
  console.log('By kind: ' + JSON.stringify(result.summary.byKind));
  for (const item of result.observations) console.log('UNCERTAIN ' + item.file + (item.line ? ':' + item.line : '') + ' ' + item.kind + ' — ' + item.detail);
  for (const item of result.parseErrors) console.log('PARSE-ERROR ' + item.file + ' — ' + item.error);
  return result;
}
if (require.main === module) {
  try { run(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..')); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
module.exports = { analyze, run, walk, parse };
