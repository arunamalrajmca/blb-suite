#!/usr/bin/env node
'use strict';

/**
 * Conservative, read-only AST audit for unused function-local bindings.
 *
 * This intentionally does not make dead-code claims. It inventories local
 * lexical bindings across every repository JavaScript file, while excluding
 * global/module declarations that may be shared across files. Dynamic scopes
 * (direct eval / with) are suppressed conservatively. Static property names
 * are indexed repository-wide, but object identity and dynamic dispatch are
 * not fully modeled; property findings remain low-confidence candidates.
 */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

function collectJavaScriptFiles(directory) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist'].includes(entry.name)) walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  }
  walk(directory);
  return files.sort();
}


function walkAst(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit, node);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visit, node);
    }
  }
}

function staticPropertyName(node, computed = false) {
  if (!node) return null;
  if (!computed && (node.type === 'Identifier' || node.type === 'PrivateIdentifier')) return node.name;
  if (computed && node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (computed && node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function memberPropertyName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  return staticPropertyName(node.property, node.computed);
}

function collectStaticPropertyReferences(ast) {
  const references = new Set();
  walkAst(ast, (node, parent) => {
    if (node.type === 'MemberExpression') {
      const name = memberPropertyName(node);
      if (name) references.add(name);
    }
    if (node.type === 'Property' && parent && parent.type === 'ObjectPattern') {
      const name = staticPropertyName(node.key, node.computed);
      if (name) references.add(name);
    }
  });
  return references;
}

function analyzePropertyReferences(ast, filename, repositoryReferences = null) {
  const definitions = [];
  const references = new Set(repositoryReferences || []);

  walkAst(ast, (node, parent) => {
    if (node.type === 'MethodDefinition' && node.key) {
      const name = staticPropertyName(node.key, node.computed);
      if (name && name !== 'constructor') definitions.push({ name, node: node.key, kind: 'class-method' });
      return;
    }

    if (node.type === 'Property' && node.value &&
        ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value.type)) {
      const name = staticPropertyName(node.key, node.computed);
      // Chrome scripting.executeScript consumes `func` as an API callback,
      // not as an ordinary object method/property reference.
      if (name && name !== 'func') {
        definitions.push({ name, node: node.key, kind: 'object-function-property' });
      }
      return;
    }

    if (node.type === 'PropertyDefinition' && node.value &&
        ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value.type)) {
      const name = staticPropertyName(node.key, node.computed);
      if (name) definitions.push({ name, node: node.key, kind: 'class-function-field' });
      return;
    }

    if (node.type === 'MemberExpression') {
      const name = memberPropertyName(node);
      if (name) references.add(name);
    }

    // Object destructuring reads a named property without a MemberExpression.
    if (node.type === 'Property' && parent && parent.type === 'ObjectPattern') {
      const name = staticPropertyName(node.key, node.computed);
      if (name) references.add(name);
    }
  });

  return definitions
    .filter(definition => !references.has(definition.name))
    .map(definition => ({
      file: filename,
      name: definition.name,
      definition: definition.kind,
      line: definition.node.loc.start.line,
      column: definition.node.loc.start.column + 1,
      scope: 'property-name-index',
      confidence: 'candidate-only',
      reason: 'No matching static member access was found in the repository-wide property-name index; dynamic/computed/reflection-based access may be invisible.'
    }));
}

function parseSource(source) {
  try {
    return {
      ast: acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowHashBang: true,
        locations: true,
        ranges: true
      }),
      sourceType: 'script'
    };
  } catch (scriptError) {
    try {
      return {
        ast: acorn.parse(source, {
          ecmaVersion: 'latest',
          sourceType: 'module',
          allowHashBang: true,
          locations: true,
          ranges: true
        }),
        sourceType: 'module'
      };
    } catch (moduleError) {
      moduleError.message = 'Unable to parse as script or module: ' + moduleError.message;
      throw moduleError;
    }
  }
}

function analyzeSource(source, filename = '<source>', repositoryReferences = null) {
  const parsed = parseSource(source);
  const ast = parsed.ast;
  const manager = eslintScope.analyze(ast, {
    ecmaVersion: 2022,
    sourceType: parsed.sourceType,
    optimistic: false,
    ignoreEval: false,
    impliedStrict: false
  });
  const findings = analyzePropertyReferences(ast, filename, repositoryReferences);
  let hasWithStatement = false;
  walkAst(ast, node => {
    if (node.type === 'WithStatement') hasWithStatement = true;
  });

  for (const scope of manager.scopes) {
    // Global declarations may be consumed by another classic script or by
    // browser/extension infrastructure. Do not classify them as dead here.
    if (scope.type === 'global' || scope.type === 'module' || scope.type === 'class') continue;
    // eslint-scope marks scopes affected by direct eval / with as dynamic.
    // Their lexical names may be observed without ordinary static reads.
    if (hasWithStatement || scope.dynamic) continue;

    for (const variable of scope.variables) {
      if (variable.references.some(reference => reference.isRead())) continue;
      const eligibleDefinitions = variable.defs.filter(definition =>
        ['Variable', 'FunctionName', 'ClassName'].includes(definition.type)
      );
      if (eligibleDefinitions.length === 0) continue;

      const definition = eligibleDefinitions[0];
      const identifier = definition.name;
      if (!identifier || !identifier.loc) continue;
      findings.push({
        file: filename,
        name: variable.name,
        definition: definition.type,
        line: identifier.loc.start.line,
        column: identifier.loc.start.column + 1,
        scope: scope.type,
        confidence: 'candidate-only',
        reason: 'No read reference was found in this file-local lexical scope.'
      });
    }
  }

  // Class declarations can appear in both their outer lexical scope and the
  // class's own scope. Collapse identical source declarations into one result.
  const unique = new Map();
  for (const finding of findings) {
    const key = [finding.file, finding.line, finding.column, finding.name].join(':');
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()].sort((a, b) =>
    a.line - b.line || a.column - b.column || a.name.localeCompare(b.name)
  );
}

function run(root = path.resolve(__dirname, '..')) {
  const extension = path.join(root, 'extension');
  if (!fs.existsSync(extension)) {
    throw new Error('Expected extension/ directory under repository root: ' + root);
  }

  const referenceFiles = collectJavaScriptFiles(root);
  const files = referenceFiles;
  const repositoryReferences = new Set();
  for (const file of referenceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const parsed = parseSource(source);
    for (const name of collectStaticPropertyReferences(parsed.ast)) repositoryReferences.add(name);
  }

  const findings = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    findings.push(...analyzeSource(
      fs.readFileSync(file, 'utf8'),
      relative,
      repositoryReferences
    ));
  }

  console.log('AST symbol-reference audit (candidate report only)');
  console.log('Repository JavaScript files analyzed for local bindings: ' + files.length);
  console.log('Extension JavaScript files included: ' + files.filter(file => file.startsWith(extension + path.sep)).length);
  console.log('Repository JavaScript files indexed for static property references: ' + referenceFiles.length);
  const localFindings = findings.filter(item => item.scope !== 'property-name-index');
  const propertyFindings = findings.filter(item => item.scope === 'property-name-index');
  console.log('Potentially unread local declarations: ' + localFindings.length);
  console.log('Potentially unreferenced method/function properties: ' + propertyFindings.length);
  console.log('Local-binding analysis covers repository JavaScript files; global declarations, parameters, object identity, and dynamic property dispatch are not proven. Dynamic lexical scopes are conservatively suppressed.');
  console.log('A finding is not proof of dead code; inspect dynamic callbacks and runtime registration.');

  for (const finding of findings) {
    console.log(
      finding.file + ':' + finding.line + ':' + finding.column +
      ' ' + finding.definition + ' ' + finding.name +
      ' [' + finding.scope + '] — ' + finding.reason
    );
  }

  return { files: files.length, findings };
}

if (require.main === module) {
  try {
    run(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
  } catch (error) {
    console.error('AST audit failed:', error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { analyzeSource, analyzePropertyReferences, collectStaticPropertyReferences, collectJavaScriptFiles, parseSource, run };
