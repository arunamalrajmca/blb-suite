#!/usr/bin/env node
'use strict';

/**
 * Conservative, read-only AST audit for unused function-local bindings.
 *
 * This intentionally does not make repository-wide dead-code claims. Classic
 * extension scripts share globals across files, and Chrome APIs, callbacks,
 * dynamic registration, computed properties, and message dispatch are not
 * reliably modeled by a per-file static scope graph. Global-scope declarations
 * are therefore excluded rather than reported as unused.
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
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  }
  walk(directory);
  return files.sort();
}

function analyzeSource(source, filename = '<source>') {
  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    locations: true,
    ranges: true
  });
  const manager = eslintScope.analyze(ast, {
    ecmaVersion: 2022,
    sourceType: 'script',
    optimistic: true,
    ignoreEval: true,
    impliedStrict: false
  });
  const findings = [];

  for (const scope of manager.scopes) {
    // Global declarations may be consumed by another classic script or by
    // browser/extension infrastructure. Do not classify them as dead here.
    if (scope.type === 'global' || scope.type === 'module') continue;

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

  return findings.sort((a, b) =>
    a.line - b.line || a.column - b.column || a.name.localeCompare(b.name)
  );
}

function run(root = path.resolve(__dirname, '..')) {
  const extension = path.join(root, 'extension');
  if (!fs.existsSync(extension)) {
    throw new Error('Expected extension/ directory under repository root: ' + root);
  }

  const files = collectJavaScriptFiles(extension);
  const findings = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    findings.push(...analyzeSource(fs.readFileSync(file, 'utf8'), relative));
  }

  console.log('AST symbol-reference audit (candidate report only)');
  console.log('Files parsed: ' + files.length);
  console.log('Potentially unread local declarations: ' + findings.length);
  console.log('Global declarations, parameters, imports, and cross-file reachability are not classified.');
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

module.exports = { analyzeSource, collectJavaScriptFiles, run };
