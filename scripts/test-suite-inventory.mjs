import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'test-suite-inventory.json'), 'utf8'));
const errors = [];
const counts = [];
function fail(message) { errors.push(message); }
function readRepoFile(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) { fail('Missing inventory-owned file: ' + relativePath); return ''; }
  return fs.readFileSync(absolute, 'utf8');
}
function listPattern(pattern) {
  const slash = pattern.lastIndexOf('/');
  const directory = slash < 0 ? '.' : pattern.slice(0, slash);
  const filePattern = slash < 0 ? pattern : pattern.slice(slash + 1);
  const escaped = filePattern.split('').map(char => '.+^()|[]\\'.includes(char) ? '\\' + char : char).join('').replaceAll('*', '.*');
  const expression = new RegExp('^' + escaped + '$');
  const absoluteDirectory = path.join(root, directory);
  if (!fs.existsSync(absoluteDirectory)) return [];
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && expression.test(entry.name))
    .map(entry => path.posix.join(directory, entry.name)).sort();
}
const classified = new Set();
for (const suite of manifest.suites) {
  const files = listPattern(suite.pattern);
  if (!files.length) fail('Suite pattern matched no files: ' + suite.id + ' (' + suite.pattern + ')');
  for (const file of files) classified.add(file);
  const ownerContent = readRepoFile(suite.owner);
  if (suite.requiredText && !ownerContent.includes(suite.requiredText)) fail('Execution owner lacks declared runner command for ' + suite.id + ': ' + suite.owner);
  if (suite.alsoOwnedBy && !readRepoFile(suite.alsoOwnedBy).includes(suite.alsoRequiredText)) fail('Secondary execution owner no longer runs ' + suite.id + ': ' + suite.alsoOwnedBy);
  if (suite.runnerFile) {
    const runner = readRepoFile(suite.runnerFile);
    for (const file of files) {
      const basename = path.basename(file);
      if (!runner.includes(suite.runnerImportPrefix + basename + "'")) fail('Discovered regression module is not imported by its runner: ' + file);
    }
  }
  for (const check of suite.runnerChecks || []) {
    if (!readRepoFile(check.file).includes(check.requiredText)) fail('Standalone test execution chain is incomplete: ' + check.file);
  }
  if (suite.id === 'ast-reachability-audit-tests') {
    for (const file of files) {
      const analysis = file.endsWith('.test.js') ? file.slice(0, -8) + '.js' : file;
      if (!fs.existsSync(path.join(root, analysis))) fail('AST regression test has no matching audit program: ' + file);
    }
  }
  for (const delegation of suite.delegations || []) {
    if (!ownerContent.includes(delegation.testTitle)) fail('Primary browser inventory no longer names delegated test: ' + delegation.testTitle);
    if (!readRepoFile(delegation.testFile).includes(delegation.testTitle)) fail('Delegated test title is missing from its declared spec: ' + delegation.testFile);
    const delegatedWorkflow = readRepoFile(delegation.workflow);
    if (!delegatedWorkflow.includes(delegation.requiredText)) fail('Delegated test is not owned by declared workflow: ' + delegation.workflow);
    if (delegation.environment === 'x11-headed-chromium') {
      if (!delegatedWorkflow.includes('BLB_HEADFUL_EXTENSION_TESTS: \'1\'')) fail('X11-owned browser test must enable headed extension mode: ' + delegation.testTitle);
      if (!delegatedWorkflow.includes('xvfb-run -a')) fail('X11-owned browser test must execute under Xvfb: ' + delegation.testTitle);
    }
  }
  counts.push({ id:suite.id, count:files.length });
}
const manualOnly = new Map(manifest.manualOnly.map(item => [item.path,item]));
const ignoredNames = new Set(['fixtures.js','extension-test-helpers.js','progress-reporter.js']);
const candidates = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if (['.git','node_modules','playwright-report','test-results'].includes(entry.name)) continue;
    const absolute = path.join(directory,entry.name);
    if (entry.isDirectory()) walk(absolute);
    else {
      const relative = path.relative(root,absolute).split(path.sep).join('/');
      const lower = entry.name.toLowerCase();
      const looksLikeTest = lower.startsWith('test-') || lower.startsWith('test_') || lower.includes('.test.') || lower.includes('.spec.') || lower.includes('test-runner');
      if (looksLikeTest && !ignoredNames.has(entry.name)) candidates.push(relative);
    }
  }
}
walk(root);
for (const candidate of candidates.sort()) if (!classified.has(candidate) && !manualOnly.has(candidate)) fail('Unclassified test-looking file: ' + candidate);
for (const item of manifest.manualOnly) if (!fs.existsSync(path.join(root,item.path))) fail('Declared manual-only harness is missing: ' + item.path);
const total = counts.reduce((sum,item)=>sum+item.count,0);
console.log('Repository test inventory');
for (const suite of counts) console.log('  '+suite.id+': '+suite.count+' file(s)');
console.log('  Automated inventory total: '+total+' file(s)');
console.log('  Explicit manual-only harnesses: '+manifest.manualOnly.length);
console.log('  Test-looking files discovered: '+candidates.length);
if (errors.length) { for (const error of errors) console.error('FAIL: '+error); process.exitCode=1; }
else console.log('PASS: every discovered test file has an explicit execution owner.');
