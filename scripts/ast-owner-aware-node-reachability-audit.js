#!/usr/bin/env node
'use strict';

/**
 * Owner-aware property/method and Node module reachability inventory.
 *
 * This is deliberately a candidate audit, not a dead-code proof. Property
 * references are attributed to a statically resolved object/class owner rather
 * than pooled by property spelling. Owners with dynamic keys, reflective use,
 * exports, or other escapes are marked uncertain and are not reported as dead.
 * Node module edges are resolved for literal relative imports/requires; dynamic
 * loading and unresolved package exports remain explicit limitations.
 */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const EXCLUDED = new Set([
  '.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist'
]);
const JS_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json'];

function walkFiles(root, predicate) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && predicate(absolute)) files.push(absolute);
    }
  }
  visit(root);
  return files.sort();
}

function walkAst(node, visit, parent = null, ancestors = []) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visit(node, parent, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit, node, next);
    } else if (value && typeof value.type === 'string') {
      walkAst(value, visit, node, next);
    }
  }
}

function parseSource(source, filename = '<source>') {
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

function staticKey(node, computed = false) {
  if (!node) return null;
  if (!computed && (node.type === 'Identifier' || node.type === 'PrivateIdentifier')) return node.name;
  if (computed && node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
  if (computed && node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function getScopeManager(ast, sourceType) {
  return eslintScope.analyze(ast, {
    ecmaVersion: 2022,
    sourceType,
    optimistic: false,
    ignoreEval: false,
    impliedStrict: false
  });
}

function ownerAwarePropertyAudit(source, filename = '<source>') {
  const parsed = parseSource(source, filename);
  const ast = parsed.ast;
  const manager = getScopeManager(ast, parsed.sourceType);
  const referenceByNode = new Map();
  const variableByDefinitionNode = new Map();
  for (const scope of manager.scopes) {
    for (const reference of scope.references || []) {
      referenceByNode.set(reference.identifier, reference);
    }
    for (const variable of scope.variables || []) {
      for (const definition of variable.defs || []) {
        if (definition.name) variableByDefinitionNode.set(definition.name, variable);
      }
    }
  }

  const owners = new Map();
  const ownerByNode = new Map();
  const classOwnerByNode = new Map();
  const classStaticOwnerByNode = new Map();
  const variableOwners = new Map();
  const classVariables = new Map();
  const classInstanceOwners = new Map();
  const classInstanceOwnerByName = new Map();
  const classStaticOwnerByName = new Map();
  const ownerByIdentifierName = new Map();

  function bindIdentifierOwner(name, owner) {
    if (!ownerByIdentifierName.has(name)) ownerByIdentifierName.set(name, owner);
    else if (ownerByIdentifierName.get(name) !== owner) ownerByIdentifierName.set(name, null);
  }

  function addOwner(id, kind, node) {
    if (!owners.has(id)) owners.set(id, {
      id, kind, line: node.loc.start.line, definitions: [], references: new Set(),
      escaped: false, escapeReasons: new Set(), dynamic: false
    });
    return owners.get(id);
  }

  walkAst(ast, (node, parent, ancestors) => {
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const declaration = ancestors.slice().reverse().find(item =>
        item.type === 'VariableDeclarator' && item.init === node
      );
      const nameNode = node.id || (declaration && declaration.id.type === 'Identifier' ? declaration.id : null);
      if (!nameNode) return;
      const id = 'class:' + filename + ':' + nameNode.name + ':' + node.loc.start.line;
      const instanceOwner = id + ':instance';
      const staticOwner = id + ':static';
      addOwner(instanceOwner, 'class-instance', node);
      addOwner(staticOwner, 'class-static', node);
      classOwnerByNode.set(node, instanceOwner);
      classStaticOwnerByNode.set(node, staticOwner);
      classInstanceOwnerByName.set(nameNode.name, instanceOwner);
      classStaticOwnerByName.set(nameNode.name, staticOwner);
      bindIdentifierOwner(nameNode.name, staticOwner);
      const variable = variableByDefinitionNode.get(nameNode) ||
        (node.type === 'ClassDeclaration'
          ? manager.scopes.flatMap(scope => scope.variables || []).find(candidate =>
              candidate.name === nameNode.name &&
              candidate.defs.some(definition => definition.type === 'ClassName')
            )
          : null);
      if (variable) {
        variableOwners.set(variable, staticOwner);
        classVariables.set(variable, staticOwner);
        classInstanceOwners.set(variable, instanceOwner);
        if (filename.startsWith('extension/') && variable.scope && variable.scope.type === 'global') {
          owners.get(staticOwner).escaped = true;
          owners.get(staticOwner).escapeReasons.add('top-level-classic-script-cross-file-contract');
          owners.get(instanceOwner).escaped = true;
          owners.get(instanceOwner).escapeReasons.add('top-level-classic-script-cross-file-contract');
        }
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      if (node.init.type === 'ObjectExpression') {
        const id = 'object:' + filename + ':' + node.id.name + ':' + node.loc.start.line;
        addOwner(id, 'object', node.init);
        ownerByNode.set(node.init, id);
        const variable = variableByDefinitionNode.get(node.id);
        if (variable) {
          variableOwners.set(variable, id);
          if (filename.startsWith('extension/') && variable.scope && variable.scope.type === 'global') {
            owners.get(id).escaped = true;
            owners.get(id).escapeReasons.add('top-level-classic-script-cross-file-contract');
          }
        }
        bindIdentifierOwner(node.id.name, id);
      } else if (node.init.type === 'NewExpression' && node.init.callee.type === 'Identifier') {
        const reference = referenceByNode.get(node.init.callee);
        const classOwner = (reference && reference.resolved
          ? classInstanceOwners.get(reference.resolved) : null) ||
          classInstanceOwnerByName.get(node.init.callee.name) || null;
        const variable = variableByDefinitionNode.get(node.id);
        if (variable && classOwner) variableOwners.set(variable, classOwner);
        if (classOwner) bindIdentifierOwner(node.id.name, classOwner);
      } else if (node.init.type === 'Identifier') {
        const sourceReference = referenceByNode.get(node.init);
        const targetVariable = variableByDefinitionNode.get(node.id);
        const sourceOwner = (sourceReference && sourceReference.resolved
          ? variableOwners.get(sourceReference.resolved) : null) ||
          ownerByIdentifierName.get(node.init.name) || null;
        if (targetVariable && sourceOwner) variableOwners.set(targetVariable, sourceOwner);
        if (sourceOwner) bindIdentifierOwner(node.id.name, sourceOwner);
      }
    }
  });

  // Resolve class declarations after all class owners have been registered.
  walkAst(ast, node => {
    if (node.type !== 'ClassDeclaration' || !node.id) return;
    const variable = variableByDefinitionNode.get(node.id);
    const owner = classOwnerByNode.get(node);
    if (variable && owner) {
      variableOwners.set(variable, classStaticOwnerByNode.get(node));
      classVariables.set(variable, classStaticOwnerByNode.get(node));
      classInstanceOwners.set(variable, owner);
    }
    bindIdentifierOwner(node.id.name, classStaticOwnerByName.get(node.id.name));
  });

  // A function's lexical class owner is used to resolve this.method accesses.
  walkAst(ast, (node, parent, ancestors) => {
    const classNode = [...ancestors].reverse().find(item =>
      item.type === 'ClassDeclaration' || item.type === 'ClassExpression'
    );
    const classOwner = classNode ? classOwnerByNode.get(classNode) : null;
    if (node.type === 'MethodDefinition' && classOwner && node.key) {
      const key = staticKey(node.key, node.computed);
      const memberOwner = node.static ? classStaticOwnerByNode.get(classNode) : classOwner;
      if (key && key !== 'constructor') owners.get(memberOwner).definitions.push({
        name: key, kind: 'class-method', line: node.key.loc.start.line
      });
    }
    if (node.type === 'PropertyDefinition' && classOwner && node.key) {
      const key = staticKey(node.key, node.computed);
      const memberOwner = node.static ? classStaticOwnerByNode.get(classNode) : classOwner;
      if (key) owners.get(memberOwner).definitions.push({
        name: key, kind: 'class-field', line: node.key.loc.start.line
      });
    }
    if (node.type === 'Property' && node.value && parent &&
        parent.type === 'ObjectExpression' && ownerByNode.has(parent)) {
      const objectNode = parent;
      const key = staticKey(node.key, node.computed);
      if (key) owners.get(ownerByNode.get(objectNode)).definitions.push({
        name: key,
        kind: node.method ? 'object-method' : 'object-property',
        line: node.key.loc.start.line
      });
    }
  });

  function resolvedOwner(identifier) {
    const reference = referenceByNode.get(identifier);
    const resolved = reference && reference.resolved
      ? variableOwners.get(reference.resolved) || null
      : null;
    return resolved || ownerByIdentifierName.get(identifier.name) ||
      classStaticOwnerByName.get(identifier.name) || null;
  }

  // Attribute member reads/writes to their receiver owner.
  walkAst(ast, (node, parent, ancestors) => {
    if (node.type === 'MemberExpression') {
      let owner = null;
      if (node.object.type === 'Identifier') owner = resolvedOwner(node.object);
      else if (node.object.type === 'ThisExpression') {
        const ownerNode = [...ancestors].reverse().find(item =>
          (item.type === 'ClassDeclaration' || item.type === 'ClassExpression') ||
          (item.type === 'ObjectExpression' && ownerByNode.has(item))
        );
        if (ownerNode && (ownerNode.type === 'ClassDeclaration' || ownerNode.type === 'ClassExpression')) {
          const methodNode = [...ancestors].reverse().find(item => item.type === 'MethodDefinition');
          owner = methodNode && methodNode.static
            ? classStaticOwnerByNode.get(ownerNode)
            : classOwnerByNode.get(ownerNode);
        } else if (ownerNode) {
          const methodProperty = [...ancestors].reverse().find(item =>
            item.type === 'Property' && item.method && item.value &&
            ['FunctionExpression', 'ArrowFunctionExpression'].includes(item.value.type)
          );
          const nestedOrdinaryFunction = methodProperty && ancestors.some(item =>
            item.type === 'FunctionExpression' && item !== methodProperty.value
          );
          if (!nestedOrdinaryFunction) owner = ownerByNode.get(ownerNode);
        }
      }
      if (!owner) return;
      const key = staticKey(node.property, node.computed);
      if (key === null) {
        owners.get(owner).dynamic = true;
        owners.get(owner).escapeReasons.add('computed-property-access');
      } else {
        owners.get(owner).references.add(key);
      }
    }

    // Object destructuring is a property read on its initializer's owner.
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' &&
        node.init && node.init.type === 'Identifier') {
      const owner = resolvedOwner(node.init);
      if (owner) {
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const key = staticKey(property.key, property.computed);
          if (key === null) owners.get(owner).dynamic = true;
          else owners.get(owner).references.add(key);
        }
      }
    }
  });

  // Detect owner escapes. Aliases and direct member accesses are understood;
  // passing/returning/storing the object, exporting it, or reflecting on it
  // makes its unreferenced members uncertain instead of a deletion candidate.
  walkAst(ast, (node, parent, ancestors) => {
    if (node.type !== 'Identifier') return;
    const owner = resolvedOwner(node);
    if (!owner) return;
    if (parent && parent.type === 'MemberExpression' && parent.object === node) return;
    if (parent && parent.type === 'VariableDeclarator' && parent.init === node) return;
    if (parent && parent.type === 'NewExpression' && parent.callee === node) return;
    if (parent && parent.type === 'Property' && parent.key === node && !parent.computed) return;
    if (parent && parent.type === 'AssignmentExpression' && parent.left === node) return;
    if (parent && parent.type === 'ClassDeclaration' && parent.id === node) return;
    if (parent && parent.type === 'VariableDeclarator' && parent.id === node) return;
    const record = owners.get(owner);
    if (record) {
      record.escaped = true;
      record.escapeReasons.add('owner-reference-used-outside-static-member-or-alias');
    }
  });

  // CommonJS exports are external consumers even when no in-repository
  // member read exists (for example, Playwright reporter lifecycle methods).
  walkAst(ast, node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=' &&
        node.left.type === 'MemberExpression') {
      const objectName = node.left.object.type === 'Identifier' ? node.left.object.name : null;
      const propertyName = staticKey(node.left.property, node.left.computed);
      if ((objectName === 'module' && propertyName === 'exports') ||
          (objectName === 'exports' && propertyName)) {
        const right = node.right;
        if (right.type === 'Identifier') {
          const owner = resolvedOwner(right);
          if (owner) {
            owners.get(owner).escaped = true;
            owners.get(owner).escapeReasons.add('commonjs-export');
          }
          const exportedInstanceOwner = classInstanceOwnerByName.get(right.name);
          if (exportedInstanceOwner && owners.has(exportedInstanceOwner)) {
            owners.get(exportedInstanceOwner).escaped = true;
            owners.get(exportedInstanceOwner).escapeReasons.add('commonjs-class-export');
          }
        }
      }
    }
  });

  // ES module exports are external consumers even when no in-repository member read exists.
  walkAst(ast, node => {
    if (node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'Identifier') {
      const owner = resolvedOwner(node.declaration);
      if (owner) { owners.get(owner).escaped = true; owners.get(owner).escapeReasons.add('module-export'); }
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const declaration = node.declaration;
      const name = declaration.id && declaration.id.name;
      if (name) {
        for (const [variable, owner] of variableOwners) {
          if (variable.name === name) {
            owners.get(owner).escaped = true;
            owners.get(owner).escapeReasons.add('module-export');
          }
        }
      }
    }
  });

  const findings = [];
  for (const owner of owners.values()) {
    if (owner.escaped || owner.dynamic) continue;
    for (const definition of owner.definitions) {
      if (!owner.references.has(definition.name)) findings.push({
        file: filename,
        owner: owner.id,
        ownerKind: owner.kind,
        ownerLine: owner.line,
        name: definition.name,
        definition: definition.kind,
        line: definition.line,
        confidence: 'candidate-only',
        reason: 'No static read was attributed to this owner; only owners without detected dynamic access or escape are reported.'
      });
    }
  }
  return {
    owners: [...owners.values()].map(owner => ({
      id: owner.id, kind: owner.kind, line: owner.line,
      properties: owner.definitions.length, references: owner.references.size,
      escaped: owner.escaped, dynamic: owner.dynamic,
      escapeReasons: [...owner.escapeReasons]
    })),
    findings
  };
}

function resolveModuleSpecifier(fromFile, specifier, files) {
  if (!specifier.startsWith('.')) return { external: true, specifier };
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (path.extname(base) === '.json' && fs.existsSync(base)) {
    return { external: true, dataDependency: true, specifier };
  }
  const candidates = [];
  if (path.extname(base)) candidates.push(base);
  else {
    for (const extension of JS_EXTENSIONS) candidates.push(base + extension);
    for (const extension of JS_EXTENSIONS) candidates.push(path.join(base, 'index' + extension));
  }
  const resolved = candidates.find(candidate => files.has(candidate));
  return resolved ? { file: resolved, external: false } : { unresolved: true, specifier };
}

function collectModuleEdges(source, filename, files) {
  const parsed = parseSource(source, filename);
  const edges = [];
  const dynamic = [];
  walkAst(parsed.ast, node => {
    let specifier = null;
    let kind = null;
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' ||
         node.type === 'ExportAllDeclaration') && node.source) {
      specifier = node.source.value;
      kind = node.type === 'ImportDeclaration' ? 'import' : 're-export';
    } else if (node.type === 'ImportExpression') {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
        specifier = node.source.value;
        kind = 'dynamic-import-literal';
      } else {
        dynamic.push({ file: filename, line: node.loc.start.line, kind: 'dynamic-import-nonliteral' });
      }
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
               node.callee.name === 'require') {
      if (node.arguments.length === 1 && node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string') {
        specifier = node.arguments[0].value;
        kind = 'require';
      } else {
        dynamic.push({ file: filename, line: node.loc.start.line, kind: 'dynamic-require' });
      }
    } else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
               node.callee.object.type === 'Identifier' && node.callee.object.name === 'module' &&
               node.callee.property.name === 'require') {
      if (node.arguments[0] && node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string') {
        specifier = node.arguments[0].value;
        kind = 'module.require';
      } else {
        dynamic.push({ file: filename, line: node.loc.start.line, kind: 'dynamic-module-require' });
      }
    }
    if (specifier !== null) {
      const resolution = resolveModuleSpecifier(filename, specifier, files);
      edges.push({ from: filename, specifier, kind, ...resolution });
    }
  });
  return { edges, dynamic };
}

function discoverNodeEntrypoints(root, files, sourceByFile) {
  const roots = new Set();
  const reasons = new Map();
  const add = (file, reason) => {
    if (!files.has(file)) return;
    roots.add(file);
    if (!reasons.has(file)) reasons.set(file, new Set());
    reasons.get(file).add(reason);
  };

  const packagePath = path.join(root, 'package.json');
  if (fs.existsSync(packagePath)) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (typeof pkg.main === 'string') {
      const target = resolveModuleSpecifier(path.join(root, 'package.json'), './' + pkg.main, files);
      if (target.file) add(target.file, 'package.main');
    }
    for (const [name, command] of Object.entries(pkg.scripts || {})) {
      for (const match of String(command).matchAll(/(?:^|\s)(\.{0,2}\/)?([A-Za-z0-9_./-]+\.(?:c?js|mjs))\b/g)) {
        const candidate = path.resolve(root, match[1] || '', match[2]);
        add(candidate, 'package-script:' + name);
      }
    }
  }

  const workflowRoot = path.join(root, '.github', 'workflows');
  const workflowFiles = fs.existsSync(workflowRoot)
    ? walkFiles(workflowRoot, file => /\.(?:yml|yaml)$/.test(file))
    : [];
  const shellEntrypoints = new Set();
  for (const workflow of workflowFiles) {
    const text = fs.readFileSync(workflow, 'utf8');
    for (const match of text.matchAll(/(?:node|npm\s+exec\s+node|npx\s+node)\s+(?:--[^\s]+\s+)*([A-Za-z0-9_./-]+\.(?:c?js|mjs))\b/g)) {
      add(path.resolve(root, match[1]), 'workflow:' + relative(root, workflow));
    }
    for (const match of text.matchAll(/(?:bash|sh)\s+([A-Za-z0-9_./-]+\.sh)\b/g)) {
      shellEntrypoints.add(path.resolve(root, match[1]));
    }
  }
  // Shell wrappers invoked by CI can launch Node scripts that are not imported
  // into the wrapper's own module graph. Recognize root-relative script paths
  // even when the shell expands a variable such as $ROOT_DIR before execution.
  for (const shellFile of shellEntrypoints) {
    if (!fs.existsSync(shellFile)) continue;
    const text = fs.readFileSync(shellFile, 'utf8');
    for (const match of text.matchAll(/(?:node|npm\s+exec\s+node)\s+(?:--[^\s]+\s+)*([A-Za-z0-9_./-]+\.(?:c?js|mjs))\b/g)) {
      add(path.resolve(path.dirname(shellFile), match[1]), 'shell-wrapper:' + relative(root, shellFile));
    }
    for (const match of text.matchAll(/((?:scripts|tests|regression-suite)\/[A-Za-z0-9_./-]+\.(?:c?js|mjs))\b/g)) {
      add(path.resolve(root, match[1]), 'shell-wrapper-path:' + relative(root, shellFile));
    }
  }

  const configFile = path.join(root, 'playwright.config.js');
  if (fs.existsSync(configFile)) {
    const config = fs.readFileSync(configFile, 'utf8');
    const reporter = /reporter\s*:\s*\[\s*\[\s*['"]([^'"]+\.(?:c?js|mjs))['"]/.exec(config);
    if (reporter) add(path.resolve(root, reporter[1]), 'playwright-reporter');
  }

  // JSON manifests may launch Node test scripts by path (for example the
  // deterministic validation-test manifest); these are entrypoints even
  // though no static require/import edge exists.
  for (const manifest of walkFiles(root, file => file.endsWith('.json') && (path.basename(file) === 'package.json' || /manifest/i.test(path.basename(file))))) {
    let value;
    try { value = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch (_) { continue; }
    const visitManifest = item => {
      if (Array.isArray(item)) return item.forEach(visitManifest);
      if (!item || typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item)) {
        if (key === 'script' && typeof child === 'string' && /\.(?:c?js|mjs)$/.test(child)) {
          add(path.resolve(path.dirname(manifest), child), 'json-script-manifest:' + relative(root, manifest));
        } else visitManifest(child);
      }
    };
    visitManifest(value);
  }

  const playwrightConfig = path.join(root, 'playwright.config.js');
  add(playwrightConfig, 'playwright-config');
  // Playwright's testDir discovery is framework-driven; model discovered specs
  // as explicit roots rather than pretending they are imported by the config.
  for (const file of files) {
    const rel = relative(root, file);
    if (rel.startsWith('tests/') && /\.(?:spec|test)\.(?:js|cjs|mjs)$/.test(rel)) {
      add(file, 'playwright-test-discovery');
    }
  }
  return { roots: [...roots].sort(), reasons };
}

function buildModuleGraph(root) {
  const fileList = walkFiles(root, file =>
    /\.(?:js|cjs|mjs)$/.test(file) && !relative(root, file).startsWith('extension/')
  );
  const files = new Set(fileList);
  const sourceByFile = new Map(fileList.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const edges = [];
  const dynamic = [];
  const unresolved = [];
  for (const [file, source] of sourceByFile) {
    const result = collectModuleEdges(source, file, files);
    edges.push(...result.edges);
    dynamic.push(...result.dynamic);
    unresolved.push(...result.edges.filter(edge => edge.unresolved));
  }

  const entrypoints = discoverNodeEntrypoints(root, files, sourceByFile);
  const outgoing = new Map();
  for (const edge of edges) {
    if (!edge.file) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.file);
  }
  const reachable = new Set();
  const queue = [...entrypoints.roots];
  while (queue.length) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const target of outgoing.get(current) || []) queue.push(target);
  }

  const candidates = fileList.filter(file => !reachable.has(file)).map(file => ({
    file: relative(root, file),
    confidence: 'candidate-only',
    reason: dynamic.some(item => item.file === file)
      ? 'No path from a discovered entrypoint; this file also contains dynamic module loading.'
      : 'No path from package scripts, workflow node commands, Playwright configuration, or discovered Playwright tests.'
  }));
  return {
    files: fileList.length,
    roots: entrypoints.roots.map(file => ({
      file: relative(root, file),
      reasons: [...(entrypoints.reasons.get(file) || [])]
    })),
    edges: edges.map(edge => ({
      from: relative(root, edge.from),
      to: edge.file ? relative(root, edge.file) : null,
      specifier: edge.specifier,
      kind: edge.kind,
      external: !!edge.external,
      unresolved: !!edge.unresolved
    })),
    dynamic: dynamic.map(item => ({ ...item, file: relative(root, item.file) })),
    unresolved: unresolved.map(item => ({
      from: relative(root, item.from), specifier: item.specifier, kind: item.kind
    })),
    reachable: [...reachable].map(file => relative(root, file)).sort(),
    candidates
  };
}

function run(root = path.resolve(__dirname, '..')) {
  const files = walkFiles(root, file => /\.(?:js|cjs|mjs)$/.test(file));
  const ownerFindings = [];
  let ownerCount = 0;
  for (const file of files) {
    const result = ownerAwarePropertyAudit(fs.readFileSync(file, 'utf8'), relative(root, file));
    ownerCount += result.owners.length;
    ownerFindings.push(...result.findings);
  }
  const graph = buildModuleGraph(root);
  console.log('Owner-aware AST and Node module reachability audit (candidate-only)');
  console.log('JavaScript modules analyzed: ' + graph.files);
  console.log('Object/class owners analyzed: ' + ownerCount);
  console.log('Owner-attributed property/method candidates: ' + ownerFindings.length);
  console.log('Node module entrypoints: ' + graph.roots.length);
  console.log('Resolved local module edges: ' + graph.edges.filter(edge => edge.to).length);
  console.log('Unresolved relative module edges: ' + graph.unresolved.length);
  console.log('Dynamic module-loading sites: ' + graph.dynamic.length);
  console.log('Unreachable module candidates: ' + graph.candidates.length);
  for (const item of ownerFindings) {
    console.log(item.file + ':' + item.line + ' ' + item.owner + ' .' + item.name +
      ' [' + item.definition + '] — ' + item.reason);
  }
  for (const item of graph.candidates) {
    console.log(item.file + ' [module candidate] — ' + item.reason);
  }
  return { ownerCount, ownerFindings, graph };
}

if (require.main === module) {
  try {
    run(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
  } catch (error) {
    console.error('Owner-aware AST audit failed:', error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  ownerAwarePropertyAudit,
  collectModuleEdges,
  resolveModuleSpecifier,
  discoverNodeEntrypoints,
  buildModuleGraph,
  run
};
