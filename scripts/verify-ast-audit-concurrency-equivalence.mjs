#!/usr/bin/env node
'use strict';

// Compare the historical one-suite-at-a-time AST audit execution with an
// isolated bounded-parallel execution on the same checkout and dependencies.
// Test assertions and audit stdout are compared; timing-only TAP lines are
// excluded. No result is inferred from a zero unreachable-candidate count.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workersArg = process.argv.find(x => x.startsWith('--workers='));
const workers = Math.max(1, Number(workersArg?.split('=')[1] || 4));
const files = fs.readdirSync(path.join(root, 'scripts'))
  .filter(name => /^ast-.*-audit\.test\.js$/.test(name))
  .sort();
if (!files.length) throw new Error('No scripts/ast-*-audit.test.js files discovered');

const tasks = files.map(testName => {
  const testFile = path.join(root, 'scripts', testName);
  const auditFile = testFile.replace(/\.test\.js$/, '.js');
  return { testName, testFile, auditFile: fs.existsSync(auditFile) ? auditFile : null };
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-audit-concurrency-'));
const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  const output = (result.stdout || '') + (result.stderr || '');
  if (result.status !== 0) {
    fs.writeFileSync(path.join(temp, label.replace(/[^a-z0-9_-]/gi, '_') + '.failure.log'), output);
    throw new Error(label + ' failed with exit ' + result.status + '\n' + output.slice(-12000));
  }
  return output;
}
function normalizeTestOutput(output) {
  return output.split(/\r?\n/)
    .filter(line => !/^# (?:duration_ms|tests|suites|pass|fail|cancelled|skipped|todo)\b/.test(line))
    .map(line => line.replace(/duration_ms:\s*[0-9.]+/g, 'duration_ms:<timing>'))
    .join('\n').trim();
}
function executeTask(task, mode) {
  const testOutput = run(process.execPath, ['--test', task.testFile], mode + '-' + task.testName + '-test');
  const auditOutput = task.auditFile
    ? run(process.execPath, [task.auditFile], mode + '-' + task.testName + '-analysis')
    : '';
  return { test: normalizeTestOutput(testOutput), audit: auditOutput.trim() };
}
function serial() {
  const results = new Map();
  for (const task of tasks) results.set(task.testName, executeTask(task, 'serial'));
  return results;
}
async function parallel() {
  const results = new Map();
  let next = 0;
  let failure = null;
  async function worker() {
    while (!failure) {
      const index = next++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      try { results.set(task.testName, executeTask(task, 'parallel')); }
      catch (error) { failure = error; return; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, worker));
  if (failure) throw failure;
  return results;
}
try {
  console.log('AST audit concurrency equivalence');
  console.log('Commit: ' + (process.env.GITHUB_SHA || 'local checkout'));
  console.log('Node: ' + process.version + '; AST audit suites: ' + tasks.length + '; parallel workers: ' + workers);
  console.log('Mode A: historical serial loop, one test process and corresponding analysis process at a time.');
  const serialResults = serial();
  console.log('Mode A complete: ' + serialResults.size + '/' + tasks.length + ' suites.');
  console.log('Mode B: bounded parallel isolated suite tasks.');
  parallel().then(parallelResults => {
    console.log('Mode B complete: ' + parallelResults.size + '/' + tasks.length + ' suites.');
    const mismatches = [];
    for (const task of tasks) {
      const a = serialResults.get(task.testName);
      const b = parallelResults.get(task.testName);
      if (!a || !b || a.test !== b.test) mismatches.push({ suite: task.testName, area: 'test outcomes' });
      if (!a || !b || a.audit !== b.audit) mismatches.push({ suite: task.testName, area: 'analysis output' });
    }
    if (mismatches.length) {
      console.error('Concurrency equivalence FAILED: ' + JSON.stringify(mismatches, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log('Concurrency equivalence PASSED: identical test outcomes and analysis output for ' + tasks.length + '/' + tasks.length + ' AST audit suites.');
    console.log('This validates this checkout, dependency set, and worker count only; it does not prove absence of all possible races.');
  }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  // Logs are retained only for the duration of the run; CI captures stdout.
  // Failure logs are emitted by the thrown error before cleanup.
  process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
}
