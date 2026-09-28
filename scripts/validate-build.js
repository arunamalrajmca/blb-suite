const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const manifestPath = path.join(ext, 'manifest.json');
const expectedSha = 'd92f96efa4ef8ef167867a4132829550deeb72eb15db4d9a3658b2d598096249';

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS:', msg); }

if (!fs.existsSync(manifestPath)) fail('extension/manifest.json missing');
else {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (m.version !== '5.2.51.35') fail(`expected version 5.2.51.35, got ${m.version}`); else pass('version 5.2.51.35');
  if ((m.permissions || []).includes('tabs')) fail('tabs permission present'); else pass('tabs permission absent');
  if ((m.host_permissions || []).some(x => x === 'http://*/*' || x === 'https://*/*')) fail('wildcard permanent host permission present'); else pass('wildcard permanent hosts absent');
  const optional = m.optional_host_permissions || [];
  if (!(optional.includes('http://*/*') && optional.includes('https://*/*'))) fail('optional wildcard hosts missing'); else pass('optional wildcard hosts present');
  const matches = (m.content_scripts || []).flatMap(x => x.matches || []);
  if (matches.some(x => x === 'http://*/*' || x === 'https://*/*')) fail('wildcard declarative content-script match present'); else pass('wildcard declarative matches absent');
}

const jsFiles = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p); else if (p.endsWith('.js')) jsFiles.push(p);
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
  const present = s === 'chrome.permissions.onAdded' ? /chrome\.permissions\?\.onAdded\?\.addListener|chrome\.permissions\.onAdded\.addListener/.test(source) : source.includes(s);
  if (present) pass(`architecture API present: ${s}`); else fail(`architecture API missing: ${s}`);
}

console.log('Expected baseline ZIP SHA-256:', expectedSha);
