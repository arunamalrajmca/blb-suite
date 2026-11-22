'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

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

function resolveLocal(root, fromFile, request) {
  if (!request || /^(?:[a-z]+:|\/|#)/i.test(request)) return null;
  const resolved = path.resolve(path.dirname(fromFile), request);
  return resolved.startsWith(root + path.sep) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? resolved : null;
}

function discover(root) {
  root = path.resolve(root);
  const extension = path.join(root, 'extension');
  const jsFiles = walk(extension, file => file.endsWith('.js'));
  const known = new Set(jsFiles);
  const roots = new Map();
  const dynamicSites = [];

  function add(file, owner, kind) {
    if (!file || !known.has(file)) return;
    if (!roots.has(file)) roots.set(file, []);
    roots.get(file).push({ owner, kind });
  }

  const manifestPath = path.join(extension, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.background && manifest.background.service_worker) {
      const worker = path.resolve(extension, manifest.background.service_worker);
      add(worker, 'extension/manifest.json', 'service-worker');
    }
    for (const [index, contentScript] of (manifest.content_scripts || []).entries()) {
      for (const file of contentScript.js || []) {
        add(path.resolve(extension, file), 'extension/manifest.json', 'content-script-' + index);
      }
    }
  }

  const htmlFiles = walk(extension, file => file.endsWith('.html'));
  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const pattern = /<script\b([^>]*)>(?:[\s\S]*?<\/script\s*>)?/gi;
    let match;
    while ((match = pattern.exec(html))) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1]);
      if (!src) continue;
      add(resolveLocal(root, htmlFile, src[1]), normalize(root, htmlFile), 'html-script');
    }
  }

  // Follow statically named importScripts() and ES module imports from known roots.
  const queue = [...roots.keys()];
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const requests = [];
    const importScripts = /\bimportScripts\s*\(([^)]*)\)/g;
    let match;
    while ((match = importScripts.exec(source))) {
      const args = match[1].matchAll(/["']([^"']+\.js)["']/g);
      for (const arg of args) requests.push({ request: arg[1], kind: 'importScripts' });
    }
    const staticImports = /(?:\bimport\s+(?:[^'"]*?\s+from\s+)?|\bexport\s+[^'"]*?\s+from\s+)["']([^"']+\.m?js)["']/g;
    while ((match = staticImports.exec(source))) requests.push({ request: match[1], kind: 'static-import' });
    for (const item of requests) {
      const target = resolveLocal(root, file, item.request);
      if (!target) continue;
      add(target, normalize(root, file), item.kind);
      if (!visited.has(target)) queue.push(target);
    }
  }

  for (const file of jsFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const patterns = [
      ['chrome.scripting.registerContentScripts', /\b(?:chrome|browser)\.scripting\.registerContentScripts\s*\(/g],
      ['chrome.scripting.executeScript', /\b(?:chrome|browser)\.scripting\.executeScript\s*\(/g],
      ['chrome.tabs.executeScript', /\b(?:chrome|browser)\.tabs\.executeScript\s*\(/g],
      ['dynamic-import', /\bimport\s*\(/g],
      ['eval-or-Function', /\b(?:eval|Function)\s*\(/g]
    ];
    for (const [api, pattern] of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        const line = source.slice(0, match.index).split('\n').length;
        dynamicSites.push({ file: normalize(root, file), line, api });
      }
    }
  }

  const entries = jsFiles.map(file => ({
    file: normalize(root, file),
    roots: roots.get(file) || [],
    classification: roots.has(file) ? 'statically-rooted-or-imported' : 'unaccounted-for'
  }));
  return {
    entries,
    dynamicSites,
    summary: {
      javascriptFiles: jsFiles.length,
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
  console.log('Statically rooted/imported: ' + result.summary.rootedOrImported);
  console.log('Unaccounted for: ' + result.summary.unaccountedFor);
  console.log('Dynamic execution/registration sites: ' + result.summary.dynamicSites);
  for (const item of result.entries) {
    if (item.classification === 'unaccounted-for') {
      console.log('UNACCOUNTED ' + item.file + ' — requires ownership review; not classified as unused');
    }
  }
  for (const item of result.dynamicSites) {
    console.log('DYNAMIC ' + item.file + ':' + item.line + ' ' + item.api +
      ' — target ownership may require runtime or interprocedural resolution');
  }
  return result;
}

if (require.main === module) {
  try {
    run(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
  } catch (error) {
    console.error('Executable-source coverage audit failed:', error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { discover, run };
