'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs'];

function walk(directory, predicate, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path.join(directory, entry.name), predicate, output);
    } else if (entry.isFile()) {
      const absolute = path.join(directory, entry.name);
      if (predicate(absolute)) output.push(absolute);
    }
  }
  return output.sort();
}
function normalize(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}
function localPath(root, fromDirectory, request) {
  if (typeof request !== 'string' || !request.trim() || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(request)) return null;
  let decoded;
  try { decoded = decodeURIComponent(request.split(/[?#]/, 1)[0]); } catch { return null; }
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(decoded.startsWith('/') ? root : fromDirectory, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  const candidates = path.extname(resolved) ? [resolved] :
    [resolved, ...JS_EXTENSIONS.map(ext => resolved + ext), ...JS_EXTENSIONS.map(ext => path.join(resolved, 'index' + ext))];
  return candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}
function parse(source, filename) {
  let lastError;
  for (const sourceType of ['script', 'module']) {
    try {
      return acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true });
    } catch (error) { lastError = error; }
  }
  const error = new Error(filename + ': ' + lastError.message);
  error.cause = lastError;
  throw error;
}
function visit(node, callback, parent = null) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  callback(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => visit(child, callback, node));
    else if (value && typeof value.type === 'string') visit(value, callback, node);
  }
}
function literal(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}
function staticArray(node) {
  if (!node || node.type !== 'ArrayExpression') return [];
  const values = [];
  for (const item of node.elements) {
    const value = literal(item);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}
function property(node, name) {
  if (!node || node.type !== 'ObjectExpression') return null;
  const item = node.properties.find(entry => entry.type === 'Property' &&
    ((entry.key.type === 'Identifier' && entry.key.name === name) || literal(entry.key) === name));
  return item ? item.value : null;
}
function discover(root) {
  root = path.resolve(root);
  const extension = path.join(root, 'extension');
  const jsFiles = walk(extension, file => JS_EXTENSIONS.includes(path.extname(file)));
  const known = new Set(jsFiles);
  const roots = new Map();
  const dynamicSites = [];
  const parsed = new Map();
  const add = (file, owner, kind) => {
    if (!file || !known.has(file)) return;
    if (!roots.has(file)) roots.set(file, []);
    const record = { owner, kind };
    if (!roots.get(file).some(item => item.owner === owner && item.kind === kind)) roots.get(file).push(record);
  };
  const addRequest = (request, fromDirectory, owner, kind) => {
    const target = localPath(extension, fromDirectory, request);
    if (target) add(target, owner, kind);
    else if (typeof request === 'string' && request.trim() && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(request)) {
      dynamicSites.push({ file: owner, line: null, api: kind, target: request, certainty: 'unresolved-local-target' });
    }
    return target;
  };

  const manifestPath = path.join(extension, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (error) {
      dynamicSites.push({ file: 'extension/manifest.json', line: null, api: 'manifest-parse', certainty: 'invalid-manifest', detail: error.message });
      manifest = {};
    }
    if (manifest.background?.service_worker) addRequest(manifest.background.service_worker, extension, 'extension/manifest.json', 'manifest-service-worker');
    for (const [index, entry] of (manifest.content_scripts || []).entries()) {
      for (const file of entry.js || []) addRequest(file, extension, 'extension/manifest.json', 'manifest-content-script-' + index);
    }
    for (const [page, file] of Object.entries(manifest.chrome_url_overrides || {})) {
      if (typeof file === 'string' && file.toLowerCase().endsWith('.html')) {
        const html = path.resolve(extension, file.replace(/^\/+/, ''));
        if (html.startsWith(extension + path.sep) && fs.existsSync(html)) {
          // The HTML page's scripts are discovered by the HTML pass below.
          dynamicSites.push({ file: 'extension/manifest.json', line: null, api: 'chrome_url_overrides.' + page, target: file, certainty: 'resolved-html-page' });
        } else dynamicSites.push({ file: 'extension/manifest.json', line: null, api: 'chrome_url_overrides.' + page, target: file, certainty: 'unresolved-html-page' });
      }
    }
  }

  // Extension HTML is parsed as a resource inventory, including quoted and
  // unquoted script src attributes and extension-root-relative URL paths.
  const htmlFiles = walk(extension, file => file.endsWith('.html'));
  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const tagPattern = /<script\b([^>]*)>/gi;
    let match;
    while ((match = tagPattern.exec(html))) {
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
      if (!src) continue;
      const request = src[1] ?? src[2] ?? src[3];
      addRequest(request, path.dirname(htmlFile), normalize(root, htmlFile), 'html-script');
    }
  }

  // Parse every extension source file once. Parse failures remain explicit
  // uncertainty rather than silently disappearing from the inventory.
  for (const file of jsFiles) {
    try { parsed.set(file, parse(fs.readFileSync(file, 'utf8'), normalize(root, file))); }
    catch (error) {
      dynamicSites.push({ file: normalize(root, file), line: null, api: 'source-parse', certainty: 'unparsed-source', detail: error.message });
    }
  }

  const queue = [...roots.keys()];
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const ast = parsed.get(file);
    if (!ast) continue;
    visit(ast, (node, parent) => {
      if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
          (node.type === 'ExportNamedDeclaration' && node.source)) {
        const target = addRequest(node.source.value, path.dirname(file), normalize(root, file), 'static-module-import');
        if (target && !visited.has(target)) queue.push(target);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'importScripts') {
        for (const arg of node.arguments) {
          const request = literal(arg);
          if (request !== null) {
            const target = addRequest(request, path.dirname(file), normalize(root, file), 'static-importScripts');
            if (target && !visited.has(target)) queue.push(target);
          } else dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'importScripts', certainty: 'dynamic-script-target' });
        }
      }
      if (node.type === 'ImportExpression') {
        const request = literal(node.source);
        if (request !== null) {
          const target = addRequest(request, path.dirname(file), normalize(root, file), 'static-dynamic-import');
          if (target && !visited.has(target)) queue.push(target);
        } else dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'dynamic-import', certainty: 'dynamic-module-target' });
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' &&
          ['Worker', 'SharedWorker'].includes(node.callee.name)) {
        let request = literal(node.arguments[0]);
        const arg = node.arguments[0];
        if (arg?.type === 'NewExpression' && arg.callee.type === 'Identifier' && arg.callee.name === 'URL') request = literal(arg.arguments[0]);
        const target = request !== null ? addRequest(request, path.dirname(file), normalize(root, file), 'worker-script') : null;
        dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: node.callee.name, target: request, certainty: target ? 'resolved-worker-target' : 'unresolved-worker-target' });
        if (target && !visited.has(target)) queue.push(target);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.computed ? literal(node.callee.property) :
          node.callee.property.type === 'Identifier' ? node.callee.property.name : null;
        if (method === 'registerContentScripts') {
          const options = node.arguments[0];
          const scripts = options?.type === 'ArrayExpression' ? options.elements : [];
          for (const script of scripts) {
            for (const key of ['js', 'css']) {
              const values = staticArray(property(script, key));
              if (values) for (const value of values) {
                const target = addRequest(value, extension, normalize(root, file), 'runtime-registered-' + key);
                if (target && !visited.has(target) && key === 'js') queue.push(target);
              }
              else dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'registerContentScripts.' + key, certainty: 'dynamic-registration-target' });
            }
          }
          if (!scripts.length) dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'registerContentScripts', certainty: 'dynamic-registration-target' });
        }
        if (method === 'executeScript') {
          const options = node.arguments[0];
          const values = staticArray(property(options, 'files'));
          if (values) for (const value of values) {
            const target = addRequest(value, extension, normalize(root, file), 'runtime-executeScript-file');
            if (target && !visited.has(target)) queue.push(target);
          }
          else dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'executeScript', certainty: 'injected-function-or-dynamic-files' });
        }
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        const key = node.left.computed ? literal(node.left.property) :
          node.left.property.type === 'Identifier' ? node.left.property.name : null;
        if (key === 'src' && node.left.object.type === 'Identifier') {
          const request = literal(node.right);
          const target = request !== null ? addRequest(request, path.dirname(file), normalize(root, file), 'dynamic-script-src') : null;
          dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'element.src', target: request, certainty: target ? 'resolved-script-src' : 'dynamic-script-src' });
          if (target && !visited.has(target)) queue.push(target);
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const method = node.callee.property.name;
        if (method === 'setAttribute' && node.arguments[0]?.type === 'Literal' && node.arguments[0].value === 'src') {
          const request = literal(node.arguments[1]);
          const target = request !== null ? addRequest(request, path.dirname(file), normalize(root, file), 'dynamic-setAttribute-src') : null;
          dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'setAttribute(src)', target: request, certainty: target ? 'resolved-script-src' : 'dynamic-script-src' });
          if (target && !visited.has(target)) queue.push(target);
        }
      }
    });
  }

  const entries = jsFiles.map(file => ({
    file: normalize(root, file),
    roots: roots.get(file) || [],
    parseStatus: parsed.has(file) ? 'parsed' : 'unparsed',
    classification: roots.has(file) ? 'statically-rooted-or-imported' : 'unaccounted-for'
  }));
  return {
    entries, dynamicSites,
    summary: {
      javascriptFiles: jsFiles.length,
      parsedFiles: parsed.size,
      rootedOrImported: entries.filter(item => item.roots.length).length,
      unaccountedFor: entries.filter(item => !item.roots.length).length,
      dynamicSites: dynamicSites.length
    }
  };
}
function run(root = path.resolve(__dirname, '..')) {
  const result = discover(root);
  console.log('Extension executable-source root coverage (inventory, not dead-code proof)');
  console.log('JavaScript files: ' + result.summary.javascriptFiles);
  console.log('Parsed files: ' + result.summary.parsedFiles);
  console.log('Statically rooted/imported: ' + result.summary.rootedOrImported);
  console.log('Unaccounted for: ' + result.summary.unaccountedFor);
  console.log('Dynamic/uncertain sites: ' + result.summary.dynamicSites);
  for (const item of result.entries) if (item.classification === 'unaccounted-for') {
    console.log('UNACCOUNTED ' + item.file + ' — requires ownership review; not classified as unused');
  }
  for (const item of result.dynamicSites) {
    console.log('UNCERTAIN ' + item.file + (item.line ? ':' + item.line : '') + ' ' + item.api + ' [' + item.certainty + ']' + (item.target ? ' ' + item.target : ''));
  }
  return result;
}
if (require.main === module) {
  try { run(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..')); }
  catch (error) { console.error('Executable-source coverage audit failed:', error.stack || error.message); process.exitCode = 1; }
}
module.exports = { discover, run, localPath, parse };
