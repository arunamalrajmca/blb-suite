#!/usr/bin/env node
'use strict';

/**
 * Repository-wide, context-aware symbol reachability inventory.
 *
 * This is an audit/reporting tool, not a dead-code proof. It models explicit
 * manifest and extension-page script groups, same-context top-level globals,
 * static property names, and common runtime registration sites. Dynamic
 * loading, reflection, generated names, and browser/runtime behavior remain
 * explicit uncertainty and suppress strong "unreferenced" conclusions.
 */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const EXCLUDED = new Set(['.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist']);

function walkFiles(root, predicate) {
  const result = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory() && !EXCLUDED.has(entry.name)) visit(absolute);
      else if (entry.isFile() && predicate(absolute)) result.push(absolute);
    }
  }
  visit(root);
  return result.sort();
}

function walkAst(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit, node);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visit, node);
    }
  }
}

function parse(source, filename) {
  let lastError;
  for (const sourceType of ['script', 'module']) {
    try {
      return {
        ast: acorn.parse(source, {
          ecmaVersion: 'latest',
          sourceType,
          allowHashBang: true,
          locations: true,
          ranges: true
        }),
        sourceType
      };
    } catch (error) {
      lastError = error;
    }
  }
  lastError.message = filename + ': ' + lastError.message;
  throw lastError;
}

function propertyName(node, computed) {
  if (!node) return null;
  if (!computed && (node.type === 'Identifier' || node.type === 'PrivateIdentifier')) return node.name;
  if (computed && node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (computed && node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

function memberName(node) {
  return node && node.type === 'MemberExpression' ? propertyName(node.property, node.computed) : null;
}

function relative(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}

function addGroup(groups, id, files, kind) {
  const normalized = [...new Set(files)].filter(Boolean);
  if (normalized.length) groups.push({ id, kind, files: normalized });
}

function staticImportScriptNames(ast) {
  const names = [];
  const constantArrays = new Map();
  walkAst(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
        node.init && node.init.type === 'ArrayExpression' &&
        node.init.elements.every(item => item && item.type === 'Literal' && typeof item.value === 'string')) {
      constantArrays.set(node.id.name, node.init.elements.map(item => item.value));
    }
  });

  walkAst(ast, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'importScripts') return;
    for (const argument of node.arguments) {
      if (argument.type === 'Literal' && typeof argument.value === 'string') names.push(argument.value);
      else if (argument.type === 'Identifier' && constantArrays.has(argument.name)) {
        names.push(...constantArrays.get(argument.name));
      } else if (argument.type === 'Identifier') {
        // Handle the common safe pattern:
        // const files = ["a.js", "b.js"]; for (const file of files) importScripts(file)
        walkAst(ast, loop => {
          if (loop.type !== 'ForOfStatement' || loop.right.type !== 'Identifier' ||
              loop.left.type !== 'VariableDeclaration') return;
          const declaration = loop.left.declarations[0];
          if (!declaration || declaration.id.type !== 'Identifier' ||
              declaration.id.name !== argument.name) return;
          const variable = declaration.id.name;
          let importsLoopVariable = false;
          walkAst(loop.body, child => {
            if (child.type === 'CallExpression' && child.callee.type === 'Identifier' &&
                child.callee.name === 'importScripts' &&
                child.arguments.some(value => value.type === 'Identifier' && value.name === variable)) {
              importsLoopVariable = true;
            }
          });
          if (importsLoopVariable && constantArrays.has(loop.right.name)) {
            names.push(...constantArrays.get(loop.right.name));
          }
        });
      }
    }
  });
  return [...new Set(names)];
}

function expandImportScripts(root, entryFile, sourceByFile) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(filename) {
    if (visited.has(filename) || visiting.has(filename)) return;
    visiting.add(filename);
    const source = sourceByFile.get(filename);
    if (source) {
      const ast = parse(source, filename).ast;
      for (const requested of staticImportScriptNames(ast)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), requested));
        if (sourceByFile.has(resolved)) visit(resolved);
      }
    }
    visiting.delete(filename);
    visited.add(filename);
    ordered.push(filename);
  }

  visit(entryFile);
  return ordered;
}

const RETAINED_SHARED_API_PROPERTIES = new Set([
  // BLBShared is deliberately exposed as a cross-context extension API. Its
  // methods are consumed by separate service-worker, content-script, popup,
  // and options-page contexts, so per-context absence is not dead-code proof.
  'extension/regex-patterns.js:isSensitiveSiteHostname',
  'extension/regex-patterns.js:isSensitiveSiteUrl',
  'extension/regex-patterns.js:whitespace',
  'extension/regex-patterns.js:booleanOperatorWords'
]);

function discoverContexts(root, sourceByFile) {
  const groups = [];
  const dynamic = [];
  const manifestPath = path.join(root, 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.background && manifest.background.service_worker) {
      const worker = relative(root, path.join(root, 'extension', manifest.background.service_worker));
      addGroup(groups, 'mv3-service-worker', expandImportScripts(root, worker, sourceByFile), 'manifest-background');
    }
    for (let i = 0; i < (manifest.content_scripts || []).length; i++) {
      const entry = manifest.content_scripts[i];
      addGroup(groups, 'manifest-content-script-' + i,
        (entry.js || []).map(file => relative(root, path.join(root, 'extension', file))),
        'manifest-content-script');
    }
  }

  const htmlFiles = walkFiles(root, file => file.endsWith('.html'));
  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const scripts = [];
    const pattern = /<script\b([^>]*)>(?:[\s\S]*?<\/script\s*>)?/gi;
    let match;
    while ((match = pattern.exec(html))) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1]);
      if (!src) continue;
      const type = /\btype\s*=\s*["']module["']/i.test(match[1]) ? 'module' : 'classic-page-script';
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative(root, htmlFile)), src[1]));
      if (sourceByFile.has(resolved)) scripts.push(resolved);
    }
    addGroup(groups, 'html:' + relative(root, htmlFile), scripts, 'extension-page');
  }

  for (const [filename, source] of sourceByFile) {
    const parsed = parse(source, filename);
    walkAst(parsed.ast, node => {
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        if (callee.type === 'Identifier' && callee.name === 'importScripts') {
          dynamic.push({ file: filename, line: node.loc.start.line, api: 'importScripts', certainty: 'runtime-loaded-script' });
        }
        if (callee.type === 'ImportExpression') {
          dynamic.push({ file: filename, line: node.loc.start.line, api: 'dynamic-import', certainty: 'runtime-loaded-module' });
        }
        if (callee.type === 'MemberExpression') {
          const name = memberName(callee);
          if (name === 'registerContentScripts') dynamic.push({ file: filename, line: node.loc.start.line, api: 'chrome.scripting.registerContentScripts', certainty: 'runtime-registered-content-script' });
          if (name === 'executeScript') dynamic.push({ file: filename, line: node.loc.start.line, api: 'chrome.scripting.executeScript', certainty: 'runtime-injected-script-or-function' });
          if (name === 'addListener' || name === 'addEventListener') dynamic.push({ file: filename, line: node.loc.start.line, api: name, certainty: 'runtime-callback-registration' });
        }
      }
    });
  }

  return { groups, dynamic };
}

function analyzeFile(source, filename) {
  const parsed = parse(source, filename);
  const manager = eslintScope.analyze(parsed.ast, {
    ecmaVersion: 2022,
    sourceType: parsed.sourceType,
    optimistic: false,
    ignoreEval: false,
    impliedStrict: false
  });
  const globalScope = manager.globalScope;
  const definitions = [];
  const properties = [];
  const propertyReferences = new Set();
  const dynamicRisk = [];

  for (const statement of parsed.ast.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id) {
      definitions.push({ name: statement.id.name, kind: 'function', line: statement.id.loc.start.line });
    } else if (statement.type === 'ClassDeclaration' && statement.id) {
      definitions.push({ name: statement.id.name, kind: 'class', line: statement.id.loc.start.line });
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || !declaration.init) continue;
        if (['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(declaration.init.type)) {
          definitions.push({ name: declaration.id.name, kind: declaration.init.type === 'ClassExpression' ? 'class-valued-global' : 'function-valued-global', line: declaration.id.loc.start.line });
        }
      }
    }
  }

  walkAst(parsed.ast, (node, parent) => {
    if (node.type === 'MemberExpression') {
      const name = memberName(node);
      if (name) propertyReferences.add(name);
      if (node.computed && !name && node.object.type === 'Identifier' &&
          ['window', 'globalThis', 'self'].includes(node.object.name)) {
        dynamicRisk.push({ line: node.loc.start.line, reason: 'computed-global-property-access' });
      }
    }
    if (node.type === 'Property' && parent && parent.type === 'ObjectPattern') {
      const name = propertyName(node.key, node.computed);
      if (name) propertyReferences.add(name);
    }
    if (node.type === 'MethodDefinition' && node.key) {
      const name = propertyName(node.key, node.computed);
      if (name && name !== 'constructor') properties.push({ name, kind: 'class-method', line: node.key.loc.start.line });
    }
    if (node.type === 'Property' && node.value && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value.type)) {
      const name = propertyName(node.key, node.computed);
      if (name && name !== 'func') properties.push({ name, kind: 'object-function-property', line: node.key.loc.start.line });
    }
    if (node.type === 'PropertyDefinition' && node.value && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value.type)) {
      const name = propertyName(node.key, node.computed);
      if (name) properties.push({ name, kind: 'class-function-field', line: node.key.loc.start.line });
    }
    if (node.type === 'WithStatement') dynamicRisk.push({ line: node.loc.start.line, reason: 'with-statement' });
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval') {
      dynamicRisk.push({ line: node.loc.start.line, reason: 'direct-eval' });
    }
  });

  const ownReads = new Set();
  // A same-named read in any lexical scope is treated as evidence against
  // declaring the global unused. This can create false negatives when a local
  // binding shadows a global, but avoids unsafe false-positive dead-code claims.
  for (const scope of manager.scopes) {
    for (const reference of scope.references || []) {
      if (reference.isRead() && reference.identifier && reference.identifier.name) {
        ownReads.add(reference.identifier.name);
      }
    }
  }
  const unresolvedReads = new Set();
  for (const reference of (globalScope && globalScope.through) || []) {
    if (reference.isRead() && reference.identifier && reference.identifier.name) unresolvedReads.add(reference.identifier.name);
  }

  return { definitions, properties, propertyReferences, ownReads, unresolvedReads, dynamicRisk };
}

function run(root = path.resolve(__dirname, '..')) {
  const jsFiles = walkFiles(root, file => file.endsWith('.js'));
  const sourceByFile = new Map(jsFiles.map(file => [relative(root, file), fs.readFileSync(file, 'utf8')]));
  const contexts = discoverContexts(root, sourceByFile);
  const analyses = new Map();
  for (const [filename, source] of sourceByFile) analyses.set(filename, analyzeFile(source, filename));

  const reports = [];
  for (const context of contexts.groups) {
    const files = context.files.filter(file => analyses.has(file));
    const definitions = new Map();
    const unresolvedReads = new Set();
    const propertyDefinitions = new Map();
    const propertyReferences = new Set();
    let hasDynamicRisk = false;

    for (const file of files) {
      const analysis = analyses.get(file);
      for (const definition of analysis.definitions) {
        if (!definitions.has(definition.name)) definitions.set(definition.name, []);
        definitions.get(definition.name).push({ ...definition, file });
      }
      for (const name of analysis.unresolvedReads) unresolvedReads.add(name);
      for (const name of analysis.ownReads) unresolvedReads.add(name);
      for (const name of analysis.propertyReferences) propertyReferences.add(name);
      for (const definition of analysis.properties) {
        if (!propertyDefinitions.has(definition.name)) propertyDefinitions.set(definition.name, []);
        propertyDefinitions.get(definition.name).push({ ...definition, file });
      }
      if (analysis.dynamicRisk.length) hasDynamicRisk = true;
    }

    const globals = [];
    for (const [name, items] of definitions) {
      if (!unresolvedReads.has(name)) {
        for (const item of items) globals.push({
          ...item,
          context: context.id,
          classification: hasDynamicRisk ? 'unresolved-dynamic-risk' : 'unreferenced-global-candidate',
          confidence: 'candidate-only',
          evidence: hasDynamicRisk
            ? 'No static read found; this execution context contains eval/with/dynamic global-property access, so reachability cannot be excluded.'
            : 'No same-context static identifier read found across the inventoried files.'
        });
      }
    }

    const properties = [];
    for (const [name, items] of propertyDefinitions) {
      if (!propertyReferences.has(name) && !items.every(item => RETAINED_SHARED_API_PROPERTIES.has(item.file + ':' + name))) {
        for (const item of items) properties.push({
          ...item,
          context: context.id,
          classification: 'unreferenced-property-name-candidate',
          confidence: 'low',
          evidence: 'No same-context static property-name read found; object identity, dynamic keys, reflection, and runtime APIs are not fully modeled.'
        });
      }
    }
    reports.push({ context: context.id, kind: context.kind, files, globals, properties, dynamicRisk: hasDynamicRisk });
  }

  const dynamic = contexts.dynamic.map(item => ({
    ...item,
    file: item.file,
    note: 'Runtime-loaded or injected code is not assumed to be covered by the static context graph.'
  }));

  console.log('Repository-wide AST reachability audit (conservative candidates only)');
  console.log('JavaScript files parsed: ' + jsFiles.length);
  console.log('Explicit execution contexts: ' + contexts.groups.length);
  console.log('Runtime loading/injection sites: ' + dynamic.length);
  console.log('Cross-file global candidates: ' + reports.reduce((sum, item) => sum + item.globals.length, 0));
  console.log('Context-scoped property candidates: ' + reports.reduce((sum, item) => sum + item.properties.length, 0));
  for (const report of reports) {
    console.log('\n[' + report.context + '] ' + report.kind + ' — ' + report.files.length + ' files' + (report.dynamicRisk ? ' — dynamic scope risk' : ''));
    for (const item of report.globals) console.log('  GLOBAL ' + item.file + ':' + item.line + ' ' + item.kind + ' ' + item.name + ' => ' + item.classification);
    for (const item of report.properties) console.log('  PROPERTY ' + item.file + ':' + item.line + ' ' + item.kind + ' ' + item.name + ' => ' + item.classification);
  }
  for (const item of dynamic) console.log('\nRUNTIME ' + item.file + ':' + item.line + ' ' + item.api + ' (' + item.certainty + ')');
  console.log('\nLimitations: unlisted execution contexts, dynamically computed references, reflection, browser-managed callbacks, and object identity are not proven. Candidates require manual review; nothing is deleted.');
  return { files: jsFiles.length, contexts: reports, dynamic };
}

if (require.main === module) {
  try {
    run(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
  } catch (error) {
    console.error('Repository reachability audit failed:', error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { analyzeFile, discoverContexts, parse, run };
