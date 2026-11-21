'use strict';

// Unified, conservative reachability graph for dynamic loading and runtime flow.
// This pass only adds positive edges and scoped uncertainty; it never proves code dead.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const SKIP = new Set(['.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist']);
const EXT = ['.js', '.cjs', '.mjs'];

function walk(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && EXT.includes(path.extname(file))) files.push(path.resolve(file));
    }
  }
  visit(root);
  return files.sort();
}
function parse(file) {
  const source = fs.readFileSync(file, 'utf8');
  let error;
  for (const sourceType of ['script', 'module']) {
    try { return acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true }); }
    catch (e) { error = e; }
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
function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
function resolveFile(from, spec, files) {
  if (typeof spec !== 'string' || !spec) return null;
  const base = path.isAbsolute(spec) ? path.resolve(spec) : path.resolve(path.dirname(from), spec);
  const candidates = path.extname(base) ? [base] : [base, ...EXT.map(ext => base + ext), ...EXT.map(ext => path.join(base, 'index' + ext))];
  return candidates.find(candidate => files.has(candidate)) || null;
}
function staticValue(node, constants, depth = 0, bindings = null) {
  if (!node || depth > 8) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node.type === 'Identifier') { const key = bindings && bindings.get(node); return key ? constants.get(key) : undefined; }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticValue(node.left, constants, depth + 1, bindings), right = staticValue(node.right, constants, depth + 1, bindings);
    if (left !== undefined && right !== undefined && ['string', 'number'].includes(typeof left) && ['string', 'number'].includes(typeof right)) return String(left) + String(right);
  }
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
      node.callee.object.name === 'path' && ['join', 'resolve'].includes(node.callee.property.name)) {
    const parts = node.arguments.map(arg => staticValue(arg, constants, depth + 1, bindings));
    if (parts.every(part => typeof part === 'string')) return node.callee.property.name === 'join' ? path.join(...parts) : path.resolve(...parts);
  }
  return undefined;
}
function bindingMap(ast) {
  const manager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: ast.sourceType || 'script', optimistic: false, ignoreEval: false });
  const ids = new Map();
  for (const scope of manager.scopes) {
    for (const variable of scope.variables || []) {
      const def = variable.identifiers && variable.identifiers[0];
      const key = variable.name + '@' + (def && def.loc ? def.loc.start.line : 0) + ':' + (def && def.loc ? def.loc.start.column : 0);
      for (const id of variable.identifiers || []) ids.set(id, key);
      for (const item of variable.defs || []) if (item.name) ids.set(item.name, key);
    }
    for (const ref of scope.references || []) if (ref.resolved) {
      const def = ref.resolved.identifiers && ref.resolved.identifiers[0];
      ids.set(ref.identifier, ref.resolved.name + '@' + (def && def.loc ? def.loc.start.line : 0) + ':' + (def && def.loc ? def.loc.start.column : 0));
    }
  }
  return ids;
}
function analyze(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  const files = walk(root), fileSet = new Set(files), asts = new Map(), errors = [];
  for (const file of files) { try { asts.set(file, parse(file)); } catch (error) { errors.push({ file: rel(root, file), error: error.message }); } }
  const edges = [], sites = [], roots = new Set(), uncertainty = [];
  const addEdge = (from, to, kind, file, line, detail) => {
    if (from && to) edges.push({ from: rel(root, from), to: rel(root, to), kind, file: rel(root, file), line, detail: detail || null });
  };
  const addSite = (file, node, kind, spec, target, certainty, rootScope) => {
    const site = { file: rel(root, file), line: node.loc.start.line, kind, expression: spec == null ? null : String(spec), resolved: target ? rel(root, target) : null, certainty, affectedRoots: rootScope || [] };
    sites.push(site);
    if (!target && certainty.startsWith('unresolved')) uncertainty.push(site);
    if (target) addEdge(file, target, kind, file, node.loc.start.line, spec);
  };

  // Explicit execution roots: Node package scripts and MV3 manifest entrypoints.
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      for (const command of Object.values(pkg.scripts || {})) {
        const match = /(?:^|&&|\|\|)\s*(?:node|nodejs)\s+(?:--[^ ]+\s+)*([^\s;&|]+)/g;
        let found;
        while ((found = match.exec(command))) {
          const target = resolveFile(path.join(root, 'package.json'), found[1], fileSet);
          if (target) roots.add(target);
        }
      }
    } catch (error) { errors.push({ file: 'package.json', error: error.message }); }
  }
  const manifestPath = path.join(root, 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const refs = [manifest.background && manifest.background.service_worker,
        manifest.action && manifest.action.default_popup, manifest.options_page,
        manifest.devtools_page, ...(manifest.content_scripts || []).flatMap(item => item.js || [])].filter(Boolean);
      for (const spec of refs) { const target = resolveFile(manifestPath, spec, fileSet); if (target) roots.add(target); }
    } catch (error) { errors.push({ file: 'extension/manifest.json', error: error.message }); }
  }
  // HTML entrypoints that own script tags (popup/options/devtools pages).
  for (const html of ['popup.html', 'options.html', 'devtools.html']) {
    const file = path.join(root, 'extension', html);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      const target = resolveFile(file, match[1], fileSet); if (target) roots.add(target);
    }
  }

  const resolveInjected = spec => resolveFile(path.join(root, 'extension', 'manifest.json'), spec, fileSet);
  const bindingByFile = new Map(), constantsByFile = new Map();
  for (const [file, ast] of asts) {
    bindingByFile.set(file, bindingMap(ast));
    const constants = new Map(), bindings = bindingByFile.get(file);
    visit(ast, node => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        const value = staticValue(node.init, constants, 0, bindings), key = bindings.get(node.id);
        if (value !== undefined && key) constants.set(key, value);
      }
    });
    constantsByFile.set(file, constants);
  }

  const exportsByFile = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file), exported = new Map();
    for (const statement of ast.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null;
      if (declaration && declaration.type === 'FunctionDeclaration' && declaration.id) {
        const key = bindings.get(declaration.id); if (key) exported.set(declaration.id.name, key);
      }
      if (declaration && declaration.type === 'VariableDeclaration') {
        for (const item of declaration.declarations || []) if (item.id.type === 'Identifier') {
          const key = bindings.get(item.id); if (key) exported.set(item.id.name, key);
        }
      }
      if (statement.type === 'ExportNamedDeclaration') {
        for (const spec of statement.specifiers || []) {
          if (statement.source) continue;
          const local = spec.local.name || spec.local.value;
          const name = spec.exported.name || spec.exported.value;
          const key = [...bindings.entries()].find(([identifier]) => identifier.name === local)?.[1];
          if (key) exported.set(name, key);
        }
      }
    }
    exportsByFile.set(file, exported);
  }

  const functionDefs = new Map();
  for (const [file, ast] of asts) {
    const bindings = bindingByFile.get(file);
    visit(ast, (node, parent) => {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const key = bindings.get(node.id); if (key) functionDefs.set(file + '::' + key, { file, node });
      } else if ((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') &&
          parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        const key = bindings.get(parent.id); if (key) functionDefs.set(file + '::' + key, { file, node });
      }
    });
  }

  for (const [file, ast] of asts) {
    const constants = constantsByFile.get(file), bindings = bindingByFile.get(file);
    const imported = new Map(), scriptElementBindings = new Set();
    visit(ast, node => {
      if (node.type === 'ImportDeclaration' && node.source.value) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) {
          addEdge(file, target, 'static-import', file, node.loc.start.line, node.source.value);
          for (const spec of node.specifiers) {
            const importedName = spec.imported ? (spec.imported.name || spec.imported.value) : 'default';
            imported.set(spec.local.name, { file: target, imported: importedName });
            const sourceKey = exportsByFile.get(target)?.get(importedName), targetKey = bindings.get(spec.local);
            if (sourceKey && targetKey) edges.push({
              from: rel(root, target) + '::' + sourceKey,
              to: rel(root, file) + '::' + targetKey,
              kind: 'cross-module-binding-import', file: rel(root, file),
              line: spec.loc.start.line, detail: importedName
            });
          }
        }
      }
    });

    visit(ast, (node, parent) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.init && node.init.type === 'CallExpression' &&
          node.init.callee.type === 'MemberExpression' &&
          node.init.callee.object.type === 'Identifier' && node.init.callee.object.name === 'document' &&
          node.init.callee.property.name === 'createElement' &&
          node.init.arguments[0] && node.init.arguments[0].type === 'Literal' &&
          node.init.arguments[0].value === 'script') scriptElementBindings.add(bindings.get(node.id));
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
          node.left.object.type === 'Identifier' && scriptElementBindings.has(bindings.get(node.left.object)) &&
          (node.left.computed ? staticValue(node.left.property, constants, 0, bindings) : node.left.property.name) === 'src') {
        const spec = staticValue(node.right, constants, 0, bindings);
        const target = typeof spec === 'string' ? resolveInjected(spec) : null;
        addSite(file, node, 'dom-script-src-injection', spec, target, target ? 'resolved-local' : 'unresolved-dom-script-injection');
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' && scriptElementBindings.has(bindings.get(node.callee.object)) &&
          (node.callee.computed ? staticValue(node.callee.property, constants, 0, bindings) : node.callee.property.name) === 'setAttribute' &&
          node.arguments[0]?.value === 'src') {
        const spec = staticValue(node.arguments[1], constants, 0, bindings);
        const target = typeof spec === 'string' ? resolveInjected(spec) : null;
        addSite(file, node, 'dom-script-setAttribute-injection', spec, target, target ? 'resolved-local' : 'unresolved-dom-script-injection');
      }
      if (node.type === 'ExportNamedDeclaration' && node.source) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) addEdge(file, target, 're-export', file, node.loc.start.line, node.source.value);
      }
      if (node.type === 'ExportAllDeclaration' && node.source) {
        const target = resolveFile(file, node.source.value, fileSet);
        if (target) addEdge(file, target, 're-export-all', file, node.loc.start.line, node.source.value);
      }
      if (node.type === 'ImportExpression') {
        const spec = staticValue(node.source, constants, 0, bindings), target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
        addSite(file, node, 'dynamic-import', spec, target, target ? 'resolved-local' : 'unresolved-dynamic-import');
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const memberPath = n => { const parts = []; while (n && n.type === 'MemberExpression') { parts.unshift(n.computed ? staticValue(n.property, constants, 0, bindings) : n.property.name); n = n.object; } if (n && n.type === 'Identifier') parts.unshift(n.name); return parts.filter(Boolean).join('.'); };
        if (callee.type === 'Identifier' && callee.name === 'importScripts') {
          for (const arg of node.arguments) {
            const spec = staticValue(arg, constants, 0, bindings), target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
            addSite(file, node, 'importScripts', spec, target, target ? 'resolved-local' : 'unresolved-importScripts');
          }
        }
        const method = callee.type === 'MemberExpression' ? (callee.computed ? staticValue(callee.property, constants, 0, bindings) : callee.property.name) : null;
        const object = callee.type === 'MemberExpression' ? memberPath(callee.object) : null;
        if (method === 'executeScript' && object === 'chrome.scripting') {
          let foundFiles = [];
          for (const arg of node.arguments) visit(arg, child => {
            if (child.type === 'Property' && (child.key.name === 'files' || child.key.value === 'files') && child.value.type === 'ArrayExpression') {
              for (const element of child.value.elements) {
                const spec = staticValue(element, constants, 0, bindings), target = typeof spec === 'string' ? resolveInjected(spec) : null;
                addSite(file, child, 'chrome.scripting.executeScript.files', spec, target, target ? 'resolved-local' : 'unresolved-script-injection');
                if (target) foundFiles.push(target);
              }
            }
            if (child.type === 'Property' && (child.key.name === 'func' || child.key.value === 'func')) {
              sites.push({ file: rel(root, file), line: child.loc.start.line, kind: 'chrome.scripting.executeScript.func', expression: '[function value]', resolved: null, certainty: 'inline-function-body', affectedRoots: [] });
            }
          });
          if (!foundFiles.length) uncertainty.push({ file: rel(root, file), line: node.loc.start.line, kind: 'chrome.scripting.executeScript', certainty: 'unresolved-injection-target', affectedRoots: [] });
        }
        if (method === 'registerContentScripts' && object === 'chrome.scripting') {
          visit(node.arguments[0], child => {
            if (child.type === 'Property' && (child.key.name === 'js' || child.key.value === 'js') && child.value.type === 'ArrayExpression') {
              for (const element of child.value.elements) {
                const spec = element.type === 'ObjectExpression' ? element.properties.find(p => p.key && (p.key.name === 'file' || p.key.value === 'file'))?.value : element;
                const value = staticValue(spec, constants, 0, bindings), target = typeof value === 'string' ? resolveInjected(value) : null;
                addSite(file, element, 'chrome.scripting.registerContentScripts', value, target, target ? 'resolved-local' : 'unresolved-registered-script');
              }
            }
          });
        }
        if (callee.type === 'Identifier' && callee.name === 'require') {
          const spec = staticValue(node.arguments[0], constants, 0, bindings), target = typeof spec === 'string' ? resolveFile(file, spec, fileSet) : null;
          if (target) addEdge(file, target, 'commonjs-require', file, node.loc.start.line, spec);
          else if (spec !== undefined && typeof spec === 'string' && spec.startsWith('.')) addSite(file, node, 'require', spec, null, 'unresolved-local-require');
        }
        // Interprocedural direct-call and callback argument edges. Imported function
        // aliases are resolved to the declaring module; unresolved names are not guessed.
        if (callee.type === 'Identifier') {
          const localKey = bindings.get(callee);
          let targetFunction = localKey && functionDefs.get(file + '::' + localKey);
          if (!targetFunction && imported.has(callee.name)) {
            const info = imported.get(callee.name);
            const targetAst = asts.get(info.file), targetBindings = bindingByFile.get(info.file);
            if (targetAst) visit(targetAst, n => {
              if (n.type === 'FunctionDeclaration' && n.id && n.id.name === info.imported) {
                const key = targetBindings.get(n.id); targetFunction = key && functionDefs.get(info.file + '::' + key);
              }
            });
          }
          if (targetFunction) {
            addEdge(file, targetFunction.file, 'function-call', file, node.loc.start.line, callee.name);
            for (let i = 0; i < Math.min(node.arguments.length, targetFunction.node.params.length); i++) {
              const arg = node.arguments[i], param = targetFunction.node.params[i];
              if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
                sites.push({ file: rel(root, file), line: arg.loc.start.line, kind: 'callback-argument', expression: callee.name + '[' + i + ']', resolved: null, certainty: 'resolved-inline-callback', affectedRoots: [] });
                if (param.type === 'Identifier') {
                  const targetKey = bindingByFile.get(targetFunction.file).get(param);
                  if (targetKey) edges.push({ from: rel(root, file) + '::function@' + arg.loc.start.line, to: rel(root, targetFunction.file) + '::' + targetKey, kind: 'cross-module-callback-parameter', file: rel(root, file), line: node.loc.start.line, detail: callee.name });
                }
              }
              if (arg.type === 'Identifier' && param.type === 'Identifier') {
                const sourceKey = bindings.get(arg), targetKey = bindingByFile.get(targetFunction.file).get(param);
                if (sourceKey && targetKey) edges.push({ from: rel(root, file) + '::' + sourceKey, to: rel(root, targetFunction.file) + '::' + targetKey, kind: 'function-argument', file: rel(root, file), line: node.loc.start.line, detail: callee.name });
              }
            }
          }
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && node.init.type === 'Identifier') {
        const from = bindings.get(node.init), to = bindings.get(node.id);
        if (from && to) edges.push({ from: rel(root, file) + '::' + from, to: rel(root, file) + '::' + to, kind: 'binding-alias', file: rel(root, file), line: node.loc.start.line, detail: node.id.name });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.computed ? staticValue(node.callee.property, constants, 0, bindings) : node.callee.property.name;
        if (['set', 'add', 'push', 'unshift'].includes(method)) {
          const receiver = node.callee.object.type === 'Identifier' ? bindings.get(node.callee.object) : null;
          for (const arg of node.arguments) if (arg.type === 'Identifier') {
            const value = bindings.get(arg);
            if (receiver && value) edges.push({ from: rel(root, file) + '::' + value, to: rel(root, file) + '::' + receiver, kind: 'container-store', file: rel(root, file), line: node.loc.start.line, detail: method });
          }
        }
        if (['get', 'pop', 'shift'].includes(method)) {
          const receiver = node.callee.object.type === 'Identifier' ? bindings.get(node.callee.object) : null;
          const assigned = parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? bindings.get(parent.id) : null;
          if (receiver && assigned) edges.push({ from: rel(root, file) + '::' + receiver, to: rel(root, file) + '::' + assigned, kind: 'container-read', file: rel(root, file), line: node.loc.start.line, detail: method });
        }
      }
      if (node.type === 'MemberExpression' && node.computed) {
        const key = staticValue(node.property, constants, 0, bindings);
        if (key === undefined) {
          uncertainty.push({ file: rel(root, file), line: node.loc.start.line, kind: 'computed-property', certainty: 'unresolved-computed-property', affectedRoots: [] });
        } else sites.push({ file: rel(root, file), line: node.loc.start.line, kind: 'constant-computed-property', expression: String(key), resolved: null, certainty: 'resolved-constant-key', affectedRoots: [] });
      }
    });
  }

  // Fold the existing per-file runtime-flow evidence into this unified graph.
  // These binding-level edges are deliberately namespaced by source file so
  // same-named locals in different modules cannot be conflated.
  const runtimeFlow = require('./ast-runtime-flow-reachability-audit');
  for (const file of asts.keys()) {
    const local = runtimeFlow.analyzeFile(root, file);
    for (const edge of local.flowEdges) {
      edges.push({
        from: rel(root, file) + '::' + edge.from,
        to: rel(root, file) + '::' + edge.to,
        kind: 'runtime-flow:' + edge.kind,
        file: rel(root, file),
        line: edge.line,
        detail: edge.detail || null
      });
    }
  }

  // Reachability and uncertainty are scoped to individual roots. A dynamic site
  // only taints descendants of the root that can reach its source file.
  const outgoing = new Map();
  for (const edge of edges) {
    if (!edge.from.includes('::')) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
      outgoing.get(edge.from).add(edge.to);
    }
  }
  const rootReach = new Map();
  for (const entry of roots) {
    const seen = new Set([entry]), queue = [entry];
    while (queue.length) { const current = queue.shift(); for (const next of outgoing.get(rel(root, current)) || []) { const absolute = path.resolve(root, next); if (!seen.has(absolute)) { seen.add(absolute); queue.push(absolute); } } }
    rootReach.set(entry, seen);
  }
  for (const site of uncertainty) {
    const source = path.resolve(root, site.file);
    site.affectedRoots = [...rootReach].filter(([, seen]) => seen.has(source)).map(([entry]) => rel(root, entry)).sort();
  }
  const reachable = new Set([...rootReach.values()].flatMap(set => [...set]));
  const unresolvedByRoot = {};
  for (const [entry, seen] of rootReach) unresolvedByRoot[rel(root, entry)] = uncertainty.filter(site => seen.has(path.resolve(root, site.file))).map(site => ({ file: site.file, line: site.line, kind: site.kind }));
  const definiteUnreachable = files.filter(file => !reachable.has(file)).map(file => rel(root, file));
  return {
    filesAnalyzed: asts.size, parseErrors: errors, roots: [...roots].map(file => rel(root, file)).sort(),
    edges, dynamicSites: sites, uncertainty, reachable: [...reachable].map(file => rel(root, file)).sort(),
    unresolvedByRoot, definiteUnreachable
  };
}
function run(root) {
  const result = analyze(root || path.resolve(__dirname, '..'));
  console.log('Unified dynamic/runtime reachability audit (conservative; not a dead-code proof)');
  console.log('Files analyzed: ' + result.filesAnalyzed);
  console.log('Parse errors: ' + result.parseErrors.length);
  console.log('Execution roots: ' + result.roots.length);
  console.log('Graph edges: ' + result.edges.length);
  console.log('Dynamic/runtime sites: ' + result.dynamicSites.length);
  console.log('Scoped uncertainty sites: ' + result.uncertainty.length);
  console.log('Reachable files: ' + result.reachable.length);
  console.log('Unreachable inventory only (not deletion candidates): ' + result.definiteUnreachable.length);
  for (const error of result.parseErrors) console.error(error.file + ': ' + error.error);
  if (result.parseErrors.length) process.exitCode = 1;
  return result;
}
if (require.main === module) run(process.argv[2]);
module.exports = { analyze, run, staticValue, resolveFile };
