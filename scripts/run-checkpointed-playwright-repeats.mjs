import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');

export function createRepeatManifest({ sourceSha, fingerprint, spec, grep, repeats, batchSize, workers, maxFailures }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new TypeError('A full source commit SHA is required.');
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new TypeError('A SHA-256 input fingerprint is required.');
  if (typeof spec !== 'string' || !spec.trim() || typeof grep !== 'string' || !grep.trim()) throw new TypeError('A spec path and exact grep expression are required.');
  for (const [name, value] of Object.entries({ repeats, batchSize, workers, maxFailures })) {
    if (!Number.isInteger(value) || value < (name === 'maxFailures' ? 0 : 1)) throw new TypeError(name + ' must be a valid positive integer.');
  }
  if (batchSize > repeats) throw new RangeError('Batch size cannot exceed the repeat count.');
  const batches = [];
  for (let index = 0; index < Math.ceil(repeats / batchSize); index++) {
    const count = Math.min(batchSize, repeats - index * batchSize);
    batches.push({ index: index + 1, repeats: count, status: 'pending', exitCode: null, reportCount: null });
  }
  return { schemaVersion:1, sourceSha, fingerprint, spec, grep, repeats, batchSize, workers, maxFailures, batches };
}

export function isCompatibleRepeatManifest(candidate, expected) {
  try {
    const base = createRepeatManifest(expected);
    return candidate?.schemaVersion === 1 &&
      ['sourceSha','fingerprint','spec','grep','repeats','batchSize','workers','maxFailures']
        .every(key => candidate[key] === base[key]) &&
      Array.isArray(candidate.batches) && candidate.batches.length === base.batches.length &&
      candidate.batches.every((batch,index) =>
        batch?.index === index + 1 &&
        batch.repeats === base.batches[index].repeats &&
        ['pending','failed','passed'].includes(batch.status) &&
        (batch.status !== 'passed' || (batch.exitCode === 0 && batch.reportCount === batch.repeats))
      );
  } catch {
    return false;
  }
}

function collectTests(report) {
  const found = [];
  function visit(suites) {
    for (const suite of suites || []) {
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          const results = test.results || [];
          const last = results.length ? results[results.length - 1] : null;
          found.push({ status:last?.status || null, overallStatus:test.status || null, expectedStatus:test.expectedStatus || null });
        }
      }
      visit(suite.suites);
    }
  }
  visit(report?.suites);
  return found;
}

function writeManifest(directory, manifest) {
  const target = path.join(directory, 'repeat-batches.json');
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(temporary, target);
}

function runBatch({ spec, grep, repeats, workers, maxFailures, outputDirectory, batchIndex }) {
  fs.mkdirSync(outputDirectory, { recursive:true });
  const args = [cli, 'test', spec, '--grep', grep, '--repeat-each=' + repeats,
    '--workers=' + workers, '--max-failures=' + maxFailures, '--reporter=json', '--output=' + outputDirectory];
  const result = spawnSync(process.execPath, args, {
    cwd:process.cwd(), encoding:'utf8', maxBuffer:64*1024*1024, timeout:30*60*1000,
    env:{ ...process.env, NO_COLOR:'1', FORCE_COLOR:'0' }
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  fs.writeFileSync(path.join(path.dirname(outputDirectory), 'repeat-batch-' + String(batchIndex).padStart(2,'0') + '.stdout.json'), stdout);
  fs.writeFileSync(path.join(path.dirname(outputDirectory), 'repeat-batch-' + String(batchIndex).padStart(2,'0') + '.stderr.log'), stderr);
  let records = [];
  let reportValid = false;
  try {
    records = collectTests(JSON.parse(stdout));
    reportValid = records.length === repeats && records.every(record =>
      record.status === 'passed' && record.overallStatus === 'expected' && record.expectedStatus === 'passed'
    );
  } catch {}
  return { exitCode:Number.isInteger(result.status) ? result.status : 1, reportCount:records.length, passed:result.status === 0 && reportValid, error:result.error ? String(result.error) : null };
}

export function runCheckpointedPlaywrightRepeats({
  directory = process.env.BLB_CI_CHECKPOINT_DIR,
  sourceSha = process.env.BLB_CI_CHECKPOINT_SOURCE_SHA,
  fingerprint = process.env.BLB_CI_CHECKPOINT_FINGERPRINT,
  spec, grep, repeats, batchSize, workers, maxFailures = 1,
  executeBatch = runBatch
}) {
  if (!directory) throw new Error('BLB_CI_CHECKPOINT_DIR is required.');
  const expected = { sourceSha, fingerprint, spec, grep, repeats, batchSize, workers, maxFailures };
  const fresh = createRepeatManifest(expected);
  fs.mkdirSync(directory, { recursive:true });
  let manifest = fresh;
  try {
    const candidate = JSON.parse(fs.readFileSync(path.join(directory, 'repeat-batches.json'), 'utf8'));
    if (isCompatibleRepeatManifest(candidate, expected)) manifest = candidate;
  } catch {}
  if (manifest === fresh) writeManifest(directory, manifest);
  for (const batch of manifest.batches) {
    if (batch.status === 'passed' && batch.exitCode === 0 && batch.reportCount === batch.repeats) {
      console.log('Reusing passed repeat batch [' + batch.index + '/' + manifest.batches.length + '] (' + batch.repeats + ' concurrent repetitions).');
      continue;
    }
    console.log('Running repeat batch [' + batch.index + '/' + manifest.batches.length + '] (' + batch.repeats + ' concurrent repetitions).');
    const result = executeBatch({
      spec, grep, repeats:batch.repeats, workers, maxFailures,
      outputDirectory:path.join(directory, 'repeat-batch-' + String(batch.index).padStart(2,'0')),
      batchIndex:batch.index
    });
    batch.status = result.passed ? 'passed' : 'failed';
    batch.exitCode = result.exitCode;
    batch.reportCount = result.reportCount;
    batch.error = result.error || null;
    writeManifest(directory, manifest);
    if (!result.passed) throw new Error('Repeat batch ' + batch.index + ' failed (exit=' + result.exitCode + ', reports=' + result.reportCount + '/' + batch.repeats + ').');
  }
  console.log('Checkpointed repeat audit passed: ' + manifest.batches.length + '/' + manifest.batches.length + ' batches; ' + repeats + ' repetitions.');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const [spec, grep, repeats, batchSize, workers, maxFailures = '1'] = process.argv.slice(2);
    if (!spec || !grep) throw new Error('Usage: node scripts/run-checkpointed-playwright-repeats.mjs <spec> <grep> <repeats> <batch-size> <workers> [max-failures]');
    runCheckpointedPlaywrightRepeats({ spec, grep, repeats:Number(repeats), batchSize:Number(batchSize), workers:Number(workers), maxFailures:Number(maxFailures) });
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
