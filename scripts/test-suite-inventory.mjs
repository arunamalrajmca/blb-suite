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
    const delegatedSpec = readRepoFile(delegation.testFile);
    const testIsDeclared = delegation.testTitlePattern
      ? new RegExp(delegation.testTitlePattern).test(delegatedSpec)
      : delegatedSpec.includes(delegation.testTitle);
    if (!testIsDeclared) fail('Delegated test title or pattern is missing from its declared spec: ' + delegation.testFile);
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
const ignoredNames = new Set(['fixtures.js','extension-test-helpers.js','progress-reporter.js','test-suite-inventory.json']);
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
const productionCoverage = manifest.productionCoverage || [];
const productionAreaIds = new Set();
for (const area of productionCoverage) {
  if (!area.id || productionAreaIds.has(area.id)) fail('Production coverage area has a missing or duplicate id: ' + area.id);
  productionAreaIds.add(area.id);
  if (!Array.isArray(area.productionFiles) || !area.productionFiles.length) fail('Production coverage area has no source modules: ' + area.id);
  if (!Array.isArray(area.testFiles) || !area.testFiles.length) fail('Production coverage area has no regression evidence: ' + area.id);
  for (const sourceFile of area.productionFiles || []) {
    if (!fs.existsSync(path.join(root, sourceFile))) fail('Production coverage source module is missing: ' + area.id + ' -> ' + sourceFile);
  }
  for (const evidence of area.testFiles || []) {
    const testFile = evidence.path;
    if (!testFile || !classified.has(testFile)) fail('Production coverage evidence is not owned by an automated suite: ' + area.id + ' -> ' + testFile);
    const testContent = readRepoFile(testFile);
    for (const requiredText of evidence.requiredText || []) {
      if (!testContent.includes(requiredText)) fail('Production coverage evidence no longer matches its regression test: ' + area.id + ' -> ' + testFile + ' -> ' + requiredText);
    }
  }
}
const productionModuleCoverage = manifest.productionModuleCoverage || [];
const extensionManifest = JSON.parse(readRepoFile('extension/manifest.json'));
const manifestModules = new Set([
  ...(extensionManifest.background?.service_worker ? ['extension/' + extensionManifest.background.service_worker] : []),
  ...(extensionManifest.content_scripts || []).flatMap(group => (group.js || []).map(file => 'extension/' + file))
]);
const extensionDirectory = path.join(root, 'extension');
const runtimeModules = new Set(fs.readdirSync(extensionDirectory, { withFileTypes:true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
  .map(entry => 'extension/' + entry.name));
const backgroundSource = readRepoFile('extension/background.js');
const startupImportMatch = backgroundSource.match(/const BLB_BACKGROUND_STARTUP_IMPORTS\\s*=\\s*(\\[[\\s\\S]*?\\]);/);
if (!startupImportMatch) fail('Background startup import inventory could not be read.');
const workerStartupImports = startupImportMatch ? JSON.parse(startupImportMatch[1]).map(file => 'extension/' + file) : [];
const mappedModules = new Map();
for (const module of productionModuleCoverage) {
  if (!module.path || mappedModules.has(module.path)) fail('Production module coverage has a missing or duplicate path: ' + module.path);
  mappedModules.set(module.path, module);
  if (!runtimeModules.has(module.path)) fail('Production module coverage entry is not an extension JavaScript module: ' + module.path);
  if (!fs.existsSync(path.join(root, module.path))) fail('Production module is missing: ' + module.path);
  if (!['direct-integration','partial-integration','indirect-integration','unmapped'].includes(module.coverageLevel)) {
    fail('Production module has an invalid coverage level: ' + module.path);
  }
  if (module.coverageLevel !== 'direct-integration' && (!module.gap || !module.gap.trim())) {
    fail('Production module gap must be explicit: ' + module.path);
  }
  if (module.coverageLevel === 'direct-integration' && (!Array.isArray(module.testFiles) || !module.testFiles.length)) {
    fail('Directly mapped production module has no test evidence: ' + module.path);
  }
  for (const evidence of module.testFiles || []) {
    if (!evidence.path || !classified.has(evidence.path)) {
      fail('Production module evidence is not owned by an automated test suite: ' + module.path + ' -> ' + evidence.path);
      continue;
    }
    const testContent = readRepoFile(evidence.path);
    for (const requiredText of evidence.requiredText || []) {
      if (!testContent.includes(requiredText)) fail('Production module evidence no longer matches its regression assertion: ' + module.path + ' -> ' + evidence.path + ' -> ' + requiredText);
    }
    if (module.coverageLevel === 'direct-integration' && !(evidence.requiredText || []).length) {
      fail('Direct integration evidence must identify its exact regression assertion: ' + module.path + ' -> ' + evidence.path);
    }
  }
}
for (const modulePath of manifestModules) {
  if (!mappedModules.has(modulePath)) fail('Manifest-loaded production module has no coverage disposition: ' + modulePath);
}
for (const modulePath of workerStartupImports) {
  if (!runtimeModules.has(modulePath)) fail('Background startup import is missing from the extension bundle: ' + modulePath);
  if (!mappedModules.has(modulePath)) fail('Background startup import has no production coverage disposition: ' + modulePath);
}
for (const modulePath of runtimeModules) {
  if (!mappedModules.has(modulePath)) fail('Extension JavaScript module has no coverage disposition: ' + modulePath);
}
for (const modulePath of mappedModules.keys()) {
  if (!runtimeModules.has(modulePath)) fail('Coverage registry contains a module outside the extension JavaScript inventory: ' + modulePath);
}
const directModuleCount = productionModuleCoverage.filter(module => module.coverageLevel === 'direct-integration').length;
const partialModuleCount = productionModuleCoverage.filter(module => module.coverageLevel === 'partial-integration').length;
const indirectModuleCount = productionModuleCoverage.filter(module => module.coverageLevel === 'indirect-integration').length;
const unmappedModuleCount = productionModuleCoverage.filter(module => module.coverageLevel === 'unmapped').length;
const total = counts.reduce((sum,item)=>sum+item.count,0);
console.log('Repository test inventory');
for (const suite of counts) console.log('  '+suite.id+': '+suite.count+' file(s)');
console.log('  Automated inventory total: '+total+' file(s)');
console.log('  Explicit manual-only harnesses: '+manifest.manualOnly.length);
console.log('  Test-looking files discovered: '+candidates.length);
console.log('  Manifest-loaded production modules: '+manifestModules.size);\nconsole.log('  All extension JavaScript modules: '+runtimeModules.size+' ('+directModuleCount+' direct integration, '+partialModuleCount+' partial integration, '+indirectModuleCount+' indirect integration, '+unmappedModuleCount+' unmapped)');\nconsole.log('  Background startup imports verified: '+workerStartupImports.length);
if (errors.length) { for (const error of errors) console.error('FAIL: '+error); process.exitCode=1; }
else console.log('PASS: every discovered test file has an explicit execution owner.');
