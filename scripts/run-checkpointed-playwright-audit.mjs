import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');

export function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function partitionTests(tests, shardCount = 4) {
  if (!Array.isArray(tests) || !tests.length) throw new TypeError('A non-empty browser test inventory is required.');
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > tests.length) {
    throw new RangeError('Shard count must be between one and the test inventory size.');
  }
  const shards = [];
  for (let index = 0; index < shardCount; index++) {
    const start = Math.floor(index * tests.length / shardCount);
    const end = Math.floor((index + 1) * tests.length / shardCount);
    shards.push(tests.slice(start, end));
  }
  return shards;
}

export function createShardManifest({ sourceSha, fingerprint, tests, shardCount = 4 }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new TypeError('A full source commit SHA is required.');
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new TypeError('A SHA-256 input fingerprint is required.');
  if (!Array.isArray(tests) || !tests.length || tests.some(item => typeof item !== 'string' || !item.trim())) {
    throw new TypeError('Browser test inventory must contain non-empty test-list entries.');
  }
  if (new Set(tests).size !== tests.length) throw new Error('Browser test inventory contains duplicate entries.');
  const shards = partitionTests(tests, shardCount);
  return {
    schemaVersion: 2,
    sourceSha,
    fingerprint,
    inventoryDigest: digest(tests),
    scheduledTests: tests.length,
    shardCount,
    shards: shards.map((entries, index) => ({
      index: index + 1,
      digest: digest(entries),
      tests: entries,
      passedTests: [],
      status: 'pending',
      exitCode: null
    }))
  };
}

export function isCompatibleShardManifest(candidate, expected) {
  try {
    const base = createShardManifest(expected);
    const crossCommit = candidate?.sourceSha !== base.sourceSha;
    const changedFiles = expected.changedFiles;
    if (crossCommit && !Array.isArray(changedFiles)) return false;
    if (!crossCommit && candidate?.fingerprint !== base.fingerprint) return false;
    if (crossCommit) {
      const referencedSpecs = new Set(base.shards.flatMap(shard => shard.tests.map(entry =>
        entry.match(/(?:^|›\s*)(tests\/browser\/[^:]+\.spec\.js)(?=:\d+)/)?.[1]
      ).filter(Boolean)));
      if (changedFiles.some(file => !referencedSpecs.has(file))) return false;
    }
    return [1, 2].includes(candidate?.schemaVersion) &&
      candidate.inventoryDigest === base.inventoryDigest &&
      candidate.scheduledTests === base.scheduledTests &&
      candidate.shardCount === base.shardCount &&
      Array.isArray(candidate.shards) &&
      candidate.shards.length === base.shards.length &&
      candidate.shards.every((shard, index) =>
        shard?.index === index + 1 &&
        shard.digest === base.shards[index].digest &&
        Array.isArray(shard.tests) &&
        shard.tests.length === base.shards[index].tests.length &&
        shard.tests.every((entry, testIndex) => entry === base.shards[index].tests[testIndex]) &&
        (candidate.schemaVersion === 1 || (
          Array.isArray(shard.passedTests) &&
          new Set(shard.passedTests).size === shard.passedTests.length &&
          shard.passedTests.every(entry => shard.tests.includes(entry))
        )) &&
        ['pending', 'failed', 'passed'].includes(shard.status) &&
        (shard.status !== 'passed' || (
          shard.exitCode === 0 && shard.reportValid === true &&
          (candidate.schemaVersion === 1 || shard.passedTests.length === shard.tests.length)
        ))
      );
  } catch {
    return false;
  }
}

export function invalidateChangedSpecShards(manifest, changedFiles) {
  const changed = new Set(changedFiles || []);
  for (const shard of manifest.shards) {
    const shardSpecs = new Set(shard.tests.map(entry =>
      entry.match(/(?:^|›\s*)(tests\/browser\/[^:]+\.spec\.js)(?=:\d+)/)?.[1]
    ).filter(Boolean));
    if (Array.from(changed).some(file => shardSpecs.has(file))) {
      shard.status = 'pending';
      shard.passedTests = [];
      shard.exitCode = null;
      shard.reportValid = false;
      delete shard.error;
    }
  }
  return manifest;
}

function writeManifest(directory, manifest) {
  const target = path.join(directory, 'browser-shards.json');
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(temporary, target);
}

function readManifest(directory, expected) {
  try {
    const candidate = JSON.parse(fs.readFileSync(path.join(directory, 'browser-shards.json'), 'utf8'));
    let compatibleExpected = expected;
    if (candidate.sourceSha !== expected.sourceSha) {
      const diff = spawnSync('git', ['diff', '--name-only', candidate.sourceSha, expected.sourceSha], {
        cwd: process.cwd(), encoding: 'utf8'
      });
      if (diff.status !== 0) return null;
      compatibleExpected = {
        ...expected,
        changedFiles: diff.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      };
    }
    if (!isCompatibleShardManifest(candidate, compatibleExpected)) return null;
    const manifest = structuredClone(candidate);
    if (manifest.schemaVersion === 1) {
      manifest.schemaVersion = 2;
      for (const shard of manifest.shards) {
        shard.passedTests = shard.status === 'passed' ? [...shard.tests] : [];
      }
    }
    if (candidate.sourceSha !== expected.sourceSha) {
      for (const shard of manifest.shards) {
        const shardSpecs = new Set(shard.tests.map(entry =>
          entry.match(/(?:^|›\s*)(tests\/browser\/[^:]+\.spec\.js)(?=:\d+)/)?.[1]
        ).filter(Boolean));
        if (compatibleExpected.changedFiles.some(file => shardSpecs.has(file))) {
          shard.status = 'pending';
          shard.exitCode = null;
          shard.reportValid = false;
          delete shard.error;
        }
      }
      manifest.sourceSha = expected.sourceSha;
      manifest.fingerprint = expected.fingerprint;
      writeManifest(directory, manifest);
      console.log('Restored compatible browser shards across commits; only shards containing changed spec files will rerun.');
    }
    return manifest;
  } catch {
    return null;
  }
}

function collectTestRecords(report) {
  const found = [];
  function visit(suites) {
    for (const suite of suites || []) {
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          const results = test.results || [];
          const last = results.length ? results[results.length - 1] : null;
          found.push({
            status: last?.status || (test.status === 'skipped' ? 'skipped' : null),
            overallStatus: test.status || null,
            expectedStatus: test.expectedStatus || null
          });
        }
      }
      visit(suite.suites);
    }
  }
  visit(report?.suites);
  return found;
}

function runShard(entries, index, directory, workers) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-browser-audit-shard-'));
  const listPath = path.join(temp, 'tests.txt');
  fs.writeFileSync(listPath, entries.join('\n') + '\n');
  const reportPath = path.join(process.cwd(), 'test-results/results.json');
  fs.rmSync(reportPath, { force: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const outputDirectory = path.join(directory, 'browser-shard-' + String(index).padStart(2, '0') + '-results');
  const args = [cli, 'test', '--test-list', listPath, '--workers=' + workers, '--max-failures=1', '--output=' + outputDirectory];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 25 * 60 * 1000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  });
  const log = (result.stdout || '') + '\n--- STDERR ---\n' + (result.stderr || '');
  fs.writeFileSync(path.join(directory, 'browser-shard-' + String(index).padStart(2, '0') + '.log'), log);
  let validReport = false;
  let passedEntries = [];
  try {
    const report = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test-results/results.json'), 'utf8'));
    const records = collectTestRecords(report);
    validReport = records.length === entries.length;
    if (validReport) {
      passedEntries = entries.filter((_entry, index) =>
        (records[index].status === 'passed' && records[index].overallStatus === 'expected') ||
        (records[index].status === 'skipped' && records[index].overallStatus === 'skipped' && records[index].expectedStatus === 'skipped')
      );
    }
  } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    passed: result.status === 0 && validReport && passedEntries.length === entries.length,
    passedEntries,
    error: result.error ? String(result.error) : null,
    validReport
  };
}

export function runCheckpointedBrowserAudit({
  testListPath,
  directory = process.env.BLB_CI_CHECKPOINT_DIR,
  sourceSha = process.env.BLB_CI_CHECKPOINT_SOURCE_SHA,
  fingerprint = process.env.BLB_CI_CHECKPOINT_FINGERPRINT,
  shardCount = 8,
  workers = 4,
  executeShard = runShard
}) {
  if (!directory) throw new Error('BLB_CI_CHECKPOINT_DIR is required.');
  const tests = fs.readFileSync(testListPath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!tests.length) throw new Error('The filtered browser test list is empty.');
  if (new Set(tests).size !== tests.length) throw new Error('The filtered browser test list contains duplicates.');
  const expected = { sourceSha, fingerprint, tests, shardCount };
  const fresh = createShardManifest(expected);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = readManifest(directory, expected) || fresh;
  if (manifest === fresh) writeManifest(directory, manifest);
  let failures = 0;
  for (const shard of manifest.shards) {
    shard.passedTests ||= shard.status === 'passed' ? [...shard.tests] : [];
    const remaining = shard.tests.filter(entry => !shard.passedTests.includes(entry));
    if (!remaining.length && shard.exitCode === 0 && shard.reportValid === true) {
      shard.status = 'passed';
      console.log('Reusing passed browser shard [' + shard.index + '/' + shardCount + '] (' + shard.tests.length + ' tests).');
      continue;
    }
    console.log('Running browser shard [' + shard.index + '/' + shardCount + '] (' + remaining.length + ' remaining tests; ' + shard.passedTests.length + ' already passed).');
    const result = executeShard(remaining, shard.index, directory, workers);
    const newlyPassed = result.validReport === true
      ? (result.passedEntries || (result.passed ? remaining : []))
      : [];
    shard.passedTests = [...new Set([...shard.passedTests, ...newlyPassed])];
    shard.status = result.passed && shard.passedTests.length === shard.tests.length ? 'passed' : 'failed';
    shard.exitCode = result.exitCode;
    shard.error = result.error || null;
    shard.reportValid = result.validReport === true;
    writeManifest(directory, manifest);
    if (shard.status !== 'passed') {
      failures++;
      console.error('Browser shard [' + shard.index + '/' + shardCount + '] failed (exit=' + result.exitCode + ', validReport=' + result.validReport + '; ' + shard.passedTests.length + '/' + shard.tests.length + ' tests retained).');
    }
  }
  const passed = manifest.shards.filter(shard => shard.status === 'passed' && shard.exitCode === 0).length;
  console.log('Checkpointed browser audit: ' + passed + '/' + shardCount + ' shards passed; ' + tests.length + ' tests scheduled.');
  if (failures || passed !== shardCount) throw new Error('One or more browser audit shards failed; successful shards have been checkpointed.');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const testListPath = process.argv[2];
    if (!testListPath) throw new Error('Usage: node scripts/run-checkpointed-playwright-audit.mjs <filtered-test-list>');
    runCheckpointedBrowserAudit({ testListPath });
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
