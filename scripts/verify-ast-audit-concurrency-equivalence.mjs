#!/usr/bin/env node
'use strict';

// Compare the historical one-suite-at-a-time AST audit execution with true
// bounded process-level parallel execution on the same checkout/dependencies.
// Test assertions and complete analysis stdout are compared. A zero
// unreachable-candidate count is never interpreted as proof of completeness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, '..');
const workersArg = process.argv.find(x => x.startsWith('--workers='));
const workers = Number(workersArg?.split('=')[1] || 4);
const roundsArg = process.argv.find(x => x.startsWith('--rounds='));
const rounds = Number(roundsArg?.split('=')[1] || 3);
if (!Number.isInteger(workers) || workers < 2) throw new Error('Concurrency validation requires --workers >= 2');
if (!Number.isInteger(rounds) || rounds < 2) throw new Error('Concurrency validation requires --rounds >= 2');

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

function digest(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'missing';
}
const fingerprint = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  acorn: require('acorn/package.json').version,
  eslintScope: require('eslint-scope/package.json').version,
  packageLock: digest(path.join(root, 'package-lock.json')),
  packageJson: digest(path.join(root, 'package.json')),
  auditInventory: tasks.map(task => ({
    test: task.testName,
    testSha256: digest(task.testFile),
    analysis: task.auditFile ? path.basename(task.auditFile) : null,
    analysisSha256: task.auditFile ? digest(task.auditFile) : null
  }))
};
function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const output = stdout + stderr;
      if (code !== 0) {
        const log = path.join(temp, label.replace(/[^a-z0-9_-]/gi, '_') + '.failure.log');
        fs.writeFileSync(log, output);
        reject(new Error(label + ' failed with exit ' + code + '; log=' + log + '\n' + output.slice(-12000)));
      } else resolve(output);
    });
  });
}
function normalizeTestOutput(output) {
  return output.split(/\r?\n/)
    .filter(line => !/^# (?:duration_ms|tests|suites|pass|fail|cancelled|skipped|todo)\b/.test(line))
    .map(line => line.replace(/duration_ms:\s*[0-9.]+/g, 'duration_ms:<timing>'))
    .join('\n').trim();
}
async function executeTask(task, mode) {
  const testOutput = await run(process.execPath, ['--test', task.testFile], mode + '-' + task.testName + '-test');
  const auditOutput = task.auditFile
    ? await run(process.execPath, [task.auditFile], mode + '-' + task.testName + '-analysis')
    : '';
  return { test: normalizeTestOutput(testOutput), audit: auditOutput.trim() };
}
async function serial() {
  const results = new Map();
  for (const task of tasks) results.set(task.testName, await executeTask(task, 'serial'));
  return results;
}
async function parallel(round) {
  const results = new Map();
  let next = 0;
  let failure = null;
  async function worker(workerIndex) {
    while (!failure) {
      const index = next++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      try { results.set(task.testName, await executeTask(task, 'parallel-r' + round + '-w' + workerIndex)); }
      catch (error) { failure = error; return; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, (_, i) => worker(i + 1)));
  if (failure) throw failure;
  return results;
}
function compare(reference, candidate, label) {
  const mismatches = [];
  for (const task of tasks) {
    const a = reference.get(task.testName);
    const b = candidate.get(task.testName);
    if (!a || !b || a.test !== b.test) mismatches.push({ suite: task.testName, area: 'test outcomes' });
    if (!a || !b || a.audit !== b.audit) mismatches.push({ suite: task.testName, area: 'analysis output' });
  }
  if (mismatches.length) throw new Error(label + ' mismatches: ' + JSON.stringify(mismatches, null, 2));
}
(async () => {
  console.log('AST audit serial/parallel equivalence');
  console.log('Commit: ' + (process.env.GITHUB_SHA || 'local checkout'));
  console.log('Fingerprint: ' + JSON.stringify(fingerprint));
  console.log('Suites: ' + tasks.length + '; actual process workers: ' + workers + '; parallel repetitions: ' + rounds);
  console.log('Mode A: serial reference, one test/analysis process at a time.');
  const serialResults = await serial();
  if (serialResults.size !== tasks.length) throw new Error('Serial inventory incomplete: ' + serialResults.size + '/' + tasks.length);
  console.log('Serial reference complete: ' + serialResults.size + '/' + tasks.length + '.');
  for (let round = 1; round <= rounds; round++) {
    console.log('Mode B parallel repetition [' + round + '/' + rounds + '].');
    const result = await parallel(round);
    if (result.size !== tasks.length) throw new Error('Parallel inventory incomplete in round ' + round + ': ' + result.size + '/' + tasks.length);
    compare(serialResults, result, 'Parallel repetition ' + round);
    console.log('Parallel repetition [' + round + '/' + rounds + '] identical: ' + result.size + '/' + tasks.length + ' suites.');
  }
  console.log('PASS: complete AST test outcomes and analysis output matched serial reference in ' + rounds + ' true parallel repetitions.');
  console.log('Scope: this commit, dependency fingerprint, environment, and worker count only; this is not proof of race-freedom for all environments.');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
});
