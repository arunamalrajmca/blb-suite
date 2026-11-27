'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const SKIP = new Set(['.git', 'coverage', 'test-results', 'playwright-report']);
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs'];

function walk(directory, predicate, output = [], symlinkPaths = [], rootDirectory = directory) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(absolute, predicate, output, symlinkPaths, rootDirectory);
    } else if (entry.isFile()) {
      if (predicate(absolute)) output.push(absolute);
    } else if (entry.isSymbolicLink()) {
      let real = null, isFile = false, isDirectory = false;
      try {
        real = fs.realpathSync(absolute);
        const stat = fs.statSync(real);
        isFile = stat.isFile();
        isDirectory = stat.isDirectory();
      } catch {}
      const withinRoot = !!real && (real === rootDirectory || real.startsWith(rootDirectory + path.sep));
      symlinkPaths.push({ path: absolute, real, isFile, isDirectory, withinRoot });
      if (withinRoot && isFile && predicate(absolute)) output.push(absolute);
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
  if (!node || node.type !== 'ArrayExpression') return null;
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
  if (fs.existsSync(root)) root = fs.realpathSync(root);
  const extension = path.join(root, 'extension');
  const symlinkPaths = [];
  const extensionFiles = walk(extension, () => true, [], symlinkPaths);
  const jsFiles = extensionFiles.filter(file => JS_EXTENSIONS.includes(path.extname(file).toLowerCase()));
  const htmlFiles = extensionFiles.filter(file => file.toLowerCase().endsWith('.html'));
  const known = new Set(jsFiles);
  const roots = new Map();
  const symlinkTargetByPath = new Map(symlinkPaths
    .filter(item => item.withinRoot && item.isFile && item.real)
    .map(item => [item.path, item.real]));
  const dynamicSites = symlinkPaths.map(item => ({
    file: normalize(root, item.path), line: null, api: 'extension-source-symlink',
    target: item.real ? normalize(root, item.real) : null,
    certainty: !item.real ? 'broken-symlink' : !item.withinRoot ? 'symlink-outside-extension-root' :
      item.isDirectory ? 'internal-directory-symlink-not-traversed' : 'internal-file-symlink'
  }));
  const parsed = new Map();
  // Some generated .js files are fetched as text and parsed as JSON; they are
  // packaged data resources, not executable entrypoints. Track those separately.
  const packagedDataResources = new Map();
  const addPackagedDataResource = (request, owner, kind) => {
    if (typeof request !== 'string' || !request.trim()) return;
    const target = localPath(extension, extension, request);
    if (!target || !known.has(target)) return;
    if (!packagedDataResources.has(target)) packagedDataResources.set(target, []);
    const record = { owner, kind };
    if (!packagedDataResources.get(target).some(item => item.owner === owner && item.kind === kind)) {
      packagedDataResources.get(target).push(record);
    }
  };
  const add = (file, owner, kind) => {
    if (!file || !known.has(file)) return;
    if (!roots.has(file)) roots.set(file, []);
    const record = { owner, kind };
    if (!roots.get(file).some(item => item.owner === owner && item.kind === kind)) roots.get(file).push(record);
    const realTarget = symlinkTargetByPath.get(file);
    if (realTarget && realTarget !== file && known.has(realTarget)) add(realTarget, owner, kind);
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
    for (const file of manifest.background?.scripts || []) addRequest(file, extension, 'extension/manifest.json', 'manifest-background-script');
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
  // unquoted script src attributes, inline scripts and inline event handlers.
  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const owner = normalize(root, htmlFile);
    const tagPattern = /<([a-z][\w:-]*)\b([^>]*)>/gi;
    let match;
    while ((match = tagPattern.exec(html))) {
      const tag = match[1].toLowerCase();
      const attributes = new Map();
      const attrPattern = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
      let attr;
      while ((attr = attrPattern.exec(match[2]))) {
        attributes.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '');
      }
      if (tag === 'script' && attributes.has('src')) {
        addRequest(attributes.get('src'), path.dirname(htmlFile), owner, 'html-script');
      }
      for (const [name, value] of attributes) {
        if (/^on[a-z]+$/i.test(name) && value.trim()) {
          dynamicSites.push({ file: owner, line: null, api: 'html-inline-event-handler', target: name, certainty: 'inline-executable-source-not-in-js-file' });
        }
        if (name === 'href' && /^javascript:/i.test(value.trim())) {
          dynamicSites.push({ file: owner, line: null, api: 'html-javascript-url', target: value.trim().slice(0, 120), certainty: 'inline-executable-source-not-in-js-file' });
        }
        if (name === 'srcdoc' && value.trim()) {
          dynamicSites.push({ file: owner, line: null, api: 'html-srcdoc', certainty: 'inline-document-source-not-in-js-file' });
        }
      }
    }
    const inlineScripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    while ((match = inlineScripts.exec(html))) {
      const attributes = match[1];
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
      if (src || !match[2].trim()) continue;
      const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
      const scriptType = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').toLowerCase();
      if (scriptType === 'importmap') {
        dynamicSites.push({ file: owner, line: null, api: 'html-import-map', certainty: 'module-specifier-resolution-map-not-applied' });
      } else if (!/^(?:application\/(?:ld\+json|json)|speculationrules)$/.test(scriptType)) {
        dynamicSites.push({ file: owner, line: null, api: 'html-inline-script', certainty: 'inline-executable-source-not-in-js-file' });
      }
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
    const literalArrays = new Map(), literalArrayNodes = new Map(), literalObjects = new Map();
    const loaderAliases = new Map();
    const expressionPath = node => {
      if (!node) return '';
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'MemberExpression') {
        const key = node.computed ? literal(node.property) :
          node.property.type === 'Identifier' ? node.property.name : null;
        return key === null ? '' : expressionPath(node.object) + '.' + key;
      }
      return '';
    };
    const supportedLoaderApis = new Set([
      'importScripts', 'chrome.scripting.executeScript', 'browser.scripting.executeScript',
      'chrome.tabs.executeScript', 'browser.tabs.executeScript',
      'chrome.scripting.registerContentScripts', 'browser.scripting.registerContentScripts',
      'chrome.userScripts.register', 'browser.userScripts.register',
      'chrome.runtime.getURL', 'browser.runtime.getURL',
      'navigator.serviceWorker.register'
    ]);
    visit(ast, node => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
          node.callee.name === 'fetchPackagedJsonAssignment') {
        addPackagedDataResource(literal(node.arguments[0]), normalize(root, file), 'packaged-data-text-fallback');
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
          node.id.name === 'fallbackAssignments' && node.init?.type === 'ObjectExpression') {
        for (const entry of node.init.properties) {
          if (entry.type !== 'Property' || entry.value?.type !== 'ArrayExpression') continue;
          addPackagedDataResource(literal(entry.value.elements[0]), normalize(root, file), 'packaged-data-text-fallback');
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        if (node.init?.type === 'Identifier' &&
            (node.init.name === 'importScripts' || loaderAliases.has(node.init.name))) {
          loaderAliases.set(node.id.name, node.init.name === 'importScripts' ? 'importScripts' : loaderAliases.get(node.init.name));
        }
        if (node.init?.type === 'MemberExpression') {
          const api = expressionPath(node.init);
          if (supportedLoaderApis.has(api)) loaderAliases.set(node.id.name, api);
        }
        if (node.init?.type === 'ArrayExpression') {
          literalArrayNodes.set(node.id.name, node.init);
          const values = staticArray(node.init);
          if (values) literalArrays.set(node.id.name, values);
        }
        if (node.init?.type === 'ObjectExpression') literalObjects.set(node.id.name, node.init);
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
        if (node.right.type === 'Identifier' &&
            (node.right.name === 'importScripts' || loaderAliases.has(node.right.name))) {
          loaderAliases.set(node.left.name, node.right.name === 'importScripts' ? 'importScripts' : loaderAliases.get(node.right.name));
        }
        if (node.right.type === 'MemberExpression') {
          const api = expressionPath(node.right);
          if (supportedLoaderApis.has(api)) loaderAliases.set(node.left.name, api);
        }
      }
    });
    // Resolve simple for-of loader loops when their iterable is a statically
    // declared literal filename array. Restrict propagation to a uniquely
    // declared loop variable so shadowed bindings remain conservative.
    const declarationCounts = new Map();
    visit(ast, node => {
      const identifiers = [];
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') identifiers.push(node.id.name);
      if (['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type) && node.id) identifiers.push(node.id.name);
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        for (const parameter of node.params || []) if (parameter.type === 'Identifier') identifiers.push(parameter.name);
      }
      if (node.type === 'CatchClause' && node.param?.type === 'Identifier') identifiers.push(node.param.name);
      for (const name of identifiers) declarationCounts.set(name, (declarationCounts.get(name) || 0) + 1);
    });
    const loopLiteralArrays = new Map();
    visit(ast, node => {
      if (node.type !== 'ForOfStatement' || node.left.type !== 'VariableDeclaration' ||
          node.left.declarations.length !== 1 || node.left.declarations[0].id.type !== 'Identifier' ||
          node.right.type !== 'Identifier') return;
      const name = node.left.declarations[0].id.name;
      const values = literalArrays.get(node.right.name);
      if (values && declarationCounts.get(name) === 1) loopLiteralArrays.set(name, values);
    });
    visit(ast, (node, parent) => {
      if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
          (node.type === 'ExportNamedDeclaration' && node.source)) {
        const request = node.source.value;
        if (!request.startsWith('.') && !request.startsWith('/')) {
          dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'bare-module-specifier', target: request, certainty: 'external-or-import-map' });
        } else {
          const target = addRequest(request, path.dirname(file), normalize(root, file), 'static-module-import');
          if (target && !visited.has(target)) queue.push(target);
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
          (node.callee.name === 'importScripts' || loaderAliases.get(node.callee.name) === 'importScripts')) {
        for (const arg of node.arguments) {
          const requests = arg.type === 'SpreadElement' && arg.argument.type === 'ArrayExpression'
            ? staticArray(arg.argument)
            : arg.type === 'SpreadElement' && arg.argument.type === 'Identifier'
              ? literalArrays.get(arg.argument.name) || loopLiteralArrays.get(arg.argument.name) || null
              : arg.type === 'Identifier'
                ? loopLiteralArrays.get(arg.name) || literalArrays.get(arg.name) || null
                : (() => { const value = literal(arg); return value === null ? null : [value]; })();
          if (requests) {
            for (const request of requests) {
              const target = addRequest(request, path.dirname(file), normalize(root, file), 'static-importScripts');
              if (target && !visited.has(target)) queue.push(target);
            }
          } else dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'importScripts', certainty: 'dynamic-script-target' });
        }
      }
      if (node.type === 'ImportExpression') {
        const request = literal(node.source);
        if (request !== null && (request.startsWith('.') || request.startsWith('/'))) {
          const target = addRequest(request, path.dirname(file), normalize(root, file), 'static-dynamic-import');
          if (target && !visited.has(target)) queue.push(target);
        } else dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'dynamic-import', target: request, certainty: request === null ? 'dynamic-module-target' : 'external-or-import-map' });
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' &&
          ['Worker', 'SharedWorker'].includes(node.callee.name)) {
        const arg = node.arguments[0];
        let request = null, baseDirectory = null, resolutionKind = 'worker-script';
        if (arg?.type === 'NewExpression' && arg.callee.type === 'Identifier' && arg.callee.name === 'URL') {
          request = literal(arg.arguments[0]);
          const base = arg.arguments[1];
          if (base?.type === 'MemberExpression' && base.object.type === 'MetaProperty') {
            baseDirectory = path.dirname(file);
            resolutionKind = 'worker-script-import-meta-url';
          } else if (base?.type === 'CallExpression' &&
              ((base.callee.type === 'MemberExpression' &&
                ['chrome.runtime.getURL', 'browser.runtime.getURL'].includes(expressionPath(base.callee))) ||
               (base.callee.type === 'Identifier' &&
                ['chrome.runtime.getURL', 'browser.runtime.getURL'].includes(loaderAliases.get(base.callee.name))))) {
            baseDirectory = extension;
            resolutionKind = 'worker-script-runtime-url';
          }
        } else if (arg?.type === 'CallExpression' && arg.callee.type === 'MemberExpression') {
          const api = (function memberName(value) {
            if (!value) return '';
            if (value.type === 'Identifier') return value.name;
            if (value.type === 'MemberExpression') return memberName(value.object) + '.' +
              (value.computed ? literal(value.property) : value.property.name);
            return '';
          })(arg.callee);
          if (['chrome.runtime.getURL', 'browser.runtime.getURL'].includes(api)) {
            request = literal(arg.arguments[0]);
            baseDirectory = extension;
            resolutionKind = 'worker-script-runtime-url';
          }
        }
        const target = request !== null && baseDirectory
          ? addRequest(request, baseDirectory, normalize(root, file), resolutionKind) : null;
        dynamicSites.push({
          file: normalize(root, file), line: node.loc.start.line, api: node.callee.name, target: request,
          certainty: target ? 'resolved-worker-target' : 'worker-target-runtime-base-uncertain'
        });
        if (target && !visited.has(target)) queue.push(target);
      }
      if (node.type === 'CallExpression' && (node.callee.type === 'MemberExpression' ||
          (node.callee.type === 'Identifier' && loaderAliases.has(node.callee.name)))) {
        const calleePath = node.callee.type === 'Identifier' ? loaderAliases.get(node.callee.name) : expressionPath(node.callee);
        // Resolve the terminal member directly as well as through the full
        // alias path. This keeps method classification reliable when a
        // computed/member-chain path is partially unresolved.
        const directMethod = node.callee.type === 'MemberExpression'
          ? (node.callee.computed ? literal(node.callee.property) :
            node.callee.property.type === 'Identifier' ? node.callee.property.name : null)
          : null;
        const method = directMethod || calleePath.split('.').pop();
        if (method === 'registerContentScripts') {
          let options = node.arguments[0];
          if (options?.type === 'Identifier') options = literalArrayNodes.get(options.name) || null;
          const scripts = options?.type === 'ArrayExpression' ? options.elements : [];
          for (let script of scripts) {
            if (script?.type === 'Identifier') script = literalObjects.get(script.name) || script;
            for (const key of ['js', 'css']) {
              const source = property(script, key);
              // js/css are optional registration fields. An omitted field is
              // not a dynamic target; only a present but non-static value is.
              if (!source) continue;
              const values = staticArray(source);
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
          let options = [...node.arguments].reverse().find(argument =>
            argument.type === 'ObjectExpression' || (argument.type === 'Identifier' && literalObjects.has(argument.name)));
          if (options?.type === 'Identifier') options = literalObjects.get(options.name) || null;
          let values = staticArray(property(options, 'files'));
          const singleFile = literal(property(options, 'file'));
          if (!values && singleFile !== null) values = [singleFile];
          if (values) for (const value of values) {
            const target = addRequest(value, extension, normalize(root, file), 'runtime-executeScript-file');
            if (target && !visited.has(target)) queue.push(target);
          }
          else dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'executeScript', certainty: 'injected-function-or-dynamic-files' });
        }
        if (method === 'register' && /(?:^|\.)serviceWorker\.register$/.test(calleePath)) {
          dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'serviceWorker.register', target: literal(node.arguments[0]), certainty: 'runtime-document-base-or-dynamic-target' });
        }
        if (['chrome.runtime.getURL', 'browser.runtime.getURL'].includes(calleePath)) {
          const request = literal(node.arguments[0]);
          if (request !== null) {
            const decoded = (() => { try { return decodeURIComponent(request.split(/[?#]/, 1)[0]); } catch { return null; } })();
            const candidate = decoded === null ? null : path.resolve(extension, decoded.replace(/^\/+/, ''));
            const isDirectoryBase = candidate && (candidate === extension || candidate.startsWith(extension + path.sep)) &&
              fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
            if (!isDirectoryBase) {
              const target = addRequest(request, extension, normalize(root, file), 'runtime-getURL-alias');
              if (target && !visited.has(target)) queue.push(target);
            }
          } else dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'runtime.getURL', certainty: 'dynamic-runtime-resource-target' });
        }
        if (method === 'register' && /(?:^|\.)userScripts\.register$/.test(calleePath)) {
          dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'userScripts.register', certainty: 'runtime-registered-user-script' });
          let descriptors = node.arguments[0];
          if (descriptors?.type === 'Identifier') descriptors = literalArrayNodes.get(descriptors.name) || null;
          const entries = descriptors?.type === 'ArrayExpression' ? descriptors.elements : [];
          for (let descriptor of entries) {
            if (descriptor?.type === 'Identifier') descriptor = literalObjects.get(descriptor.name) || descriptor;
            for (const key of ['js', 'css']) {
              const scripts = property(descriptor, key);
              const scriptEntries = scripts?.type === 'Identifier' ? literalArrayNodes.get(scripts.name)?.elements :
                scripts?.type === 'ArrayExpression' ? scripts.elements : [];
              for (let script of scriptEntries || []) {
                if (script?.type === 'Identifier') script = literalObjects.get(script.name) || script;
                const request = literal(property(script, 'file'));
                if (request !== null) {
                  const target = addRequest(request, extension, normalize(root, file), 'runtime-userScripts-' + key);
                  if (target && !visited.has(target) && key === 'js') queue.push(target);
                } else if (literal(property(script, 'code')) !== null) {
                  dynamicSites.push({ file: normalize(root, file), line: node.loc.start.line, api: 'userScripts.inline-code', certainty: 'runtime-generated-script-code' });
                }
              }
            }
          }
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
        const method = node.callee.computed ? literal(node.callee.property) :
          node.callee.property.type === 'Identifier' ? node.callee.property.name : null;
        if (['write', 'writeln', 'insertAdjacentHTML'].includes(method)) {
          const markup = node.arguments.map(literal).filter(value => value !== null).join(' ');
          const targets = [...markup.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
            .map(match => match[1] || match[2] || match[3]);
          dynamicSites.push({
            file: normalize(root, file), line: node.loc.start.line, api: 'dynamic-html-script-insertion',
            targets, certainty: targets.length ? 'static-script-path-with-runtime-base' : 'dynamic-markup-or-script-target'
          });
        }
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        const key = node.left.computed ? literal(node.left.property) :
          node.left.property.type === 'Identifier' ? node.left.property.name : null;
        if (['innerHTML', 'outerHTML'].includes(key)) {
          const markup = literal(node.right);
          const targets = markup === null ? [] :
            [...markup.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
              .map(match => match[1] || match[2] || match[3]);
          dynamicSites.push({
            file: normalize(root, file), line: node.loc.start.line, api: 'dynamic-html-property-insertion',
            targets, certainty: targets.length ? 'static-script-path-with-runtime-base' : 'dynamic-markup-or-script-target'
          });
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
    dataReferences: packagedDataResources.get(file) || [],
    parseStatus: parsed.has(file) ? 'parsed' : 'unparsed',
    classification: roots.has(file) ? 'statically-rooted-or-imported' :
      packagedDataResources.has(file) ? 'packaged-data-resource' : 'unaccounted-for'
  }));
  return {
    entries, dynamicSites,
    summary: {
      javascriptFiles: jsFiles.length,
      parsedFiles: parsed.size,
      rootedOrImported: entries.filter(item => item.roots.length).length,
      packagedDataResources: entries.filter(item => item.classification === 'packaged-data-resource').length,
      unaccountedFor: entries.filter(item => item.classification === 'unaccounted-for').length,
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
  console.log('Packaged data resources: ' + result.summary.packagedDataResources);
  console.log('Unaccounted for: ' + result.summary.unaccountedFor);
  console.log('Dynamic/uncertain sites: ' + result.summary.dynamicSites);
  for (const item of result.entries) if (item.classification === 'packaged-data-resource') {
    console.log('DATA RESOURCE ' + item.file + ' — fetched as text/parsed data; not an executable root');
  }
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
