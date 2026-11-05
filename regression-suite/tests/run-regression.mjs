import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { registerPackageTests } from './package-tests.mjs';
import { registerResolverTests } from './resolver-tests.mjs';
import {
  registerFeatureSearchTests,
  registerFeatureIntegrationTests,
  registerStudySessionTests
} from './feature-tests.mjs';
import {
  registerSelectionContextTests,
  registerSelectionActionTests,
  registerSelectionMultiVerseTests,
  registerSelectionClassificationTests
} from './selection-tests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(HERE, '..', 'extension');
const ROOT = path.resolve(process.argv[2] || defaultRoot);
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures.json'), 'utf8'));
const expectedVersion = process.env.BLB_EXPECTED_VERSION || JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const failures = [];
let passed = 0;
const requestedGroup = process.argv.find(arg => arg.startsWith('--group='))?.slice('--group='.length) || 'all';
let currentGroup = 'features';
function section(group) { currentGroup = group; }
function test(name, fn) {
  if (requestedGroup !== 'all' && requestedGroup !== currentGroup) return;
  try { fn(); passed++; console.log(`✓ [${currentGroup}] ${name}`); }
  catch (error) { failures.push({ name, error: error.message, group: currentGroup }); console.log(`✗ [${currentGroup}] ${name}\\n  ${error.message}`); }
}
function read(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8'); }
function loadPure(files) {
  const ctx = vm.createContext({ console, Set, Map, Object, Number, String, Array, Math, RegExp, JSON, Buffer, atob: value => Buffer.from(value, 'base64').toString('binary'), window: {} });
  ctx.self = ctx;
  for (const file of files) vm.runInContext(read(file), ctx, { filename: file });
  return ctx;
}
const context = { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg: read('background.js'), content: read('content.js') };

console.log(`BLB Suite Regression Suite — manifest ${expectedVersion}`);
console.log(`Package: ${ROOT}\\n`);

registerPackageTests(context);
registerResolverTests(context);
registerFeatureSearchTests(context);
registerSelectionContextTests(context);
registerSelectionActionTests(context);
registerSelectionMultiVerseTests(context);
registerFeatureIntegrationTests(context);
registerStudySessionTests(context);
registerSelectionClassificationTests(context);

console.log(`\\nGROUP: ${requestedGroup}\\nRESULT: ${failures.length ? 'FAIL' : 'PASS'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\\nFailures:');
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error}`);
  process.exitCode = 1;
}
