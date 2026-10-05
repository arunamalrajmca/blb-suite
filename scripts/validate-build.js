const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const manifestPath = path.join(ext, 'manifest.json');
const packagePath = path.join(root, 'package.json');

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS:', msg); }

if (!fs.existsSync(manifestPath)) {
  fail('extension/manifest.json missing');
} else {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = m.version;
  if (!version) fail('manifest version missing'); else pass(`manifest version ${version}`);

  if (!fs.existsSync(packagePath)) {
    fail('package.json missing');
  } else {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (pkg.version !== version) fail(`package.json version ${pkg.version} != manifest ${version}`);
    else pass(`package.json version matches manifest ${version}`);
  }

  if (!(m.permissions || []).includes('tabs')) fail('tabs permission missing');
  else pass('tabs permission present');

  const hosts = m.host_permissions || [];
  if (!(hosts.includes('http://*/*') && hosts.includes('https://*/*'))) fail('required wildcard host permissions missing');
  else pass('required wildcard host permissions present');

  if (m.optional_host_permissions) fail('optional_host_permissions must not replace required host access');
  else pass('optional host permissions absent');

  const matches = (m.content_scripts || []).flatMap(x => x.matches || []);
  if (matches.some(x => x === 'http://*/*' || x === 'https://*/*')) pass('wildcard declarative content-script matches present');
  else fail('wildcard declarative content-script matches missing');
}

const jsFiles = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.js')) jsFiles.push(p);
  }
}
walk(ext);

for (const file of jsFiles) {
  const r = cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`syntax: ${path.relative(root, file)}\n${r.stderr}`);
}
if (!process.exitCode) pass(`${jsFiles.length} JavaScript files parse successfully`);

const source = jsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
for (const s of ['chrome.permissions.request', 'chrome.permissions.contains', 'chrome.permissions.onAdded', 'chrome.scripting.executeScript']) {
  const present = s === 'chrome.permissions.onAdded'
    ? /chrome\.permissions\?\.onAdded\?\.addListener|chrome\.permissions\.onAdded\.addListener/.test(source)
    : source.includes(s);
  if (present) pass(`architecture API present: ${s}`);
  else fail(`architecture API missing: ${s}`);
}
