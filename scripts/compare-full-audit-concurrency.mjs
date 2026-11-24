import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const cli = require.resolve('@playwright/test/cli');
const reportRoot = process.env.BLB_CONCURRENCY_REPORT_DIR || path.join(root, 'artifacts', 'full-audit-concurrency');
fs.mkdirSync(reportRoot, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-concurrency-'));
const listPath = path.join(tempRoot, 'complete-browser-test-list.txt');
const delegatedTitles = [
  'a real MV3 service-worker termination is recovered by the physical Alt+B browser shortcut',
  'native Chromium _self prerender activation initializes the activated document without tab replacement',
  'native Chromium _blank prerender activation initializes the activated document without tab replacement',
  'Show on BLB performance benchmark',
  'Interleaved baseline/candidate performance batch preserves isolated samples'
];

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, 'test', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...options.env }
  });
}
function parseJsonReport(stdout, label) {
  try { return JSON.parse(stdout); }
  catch (error) { throw new Error(label + ': Playwright JSON reporter output was not valid JSON: ' + error.message); }
}
function collectTests(report) {
  const found = [];
  function visit(suites, parentTitles = []) {
    for (const suite of suites || []) {
      const suiteTitles = suite.title ? [...parentTitles, suite.title] : parentTitles;
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          const results = test.results || [];
          const last = results.length ? results[results.length - 1] : null;
          const status = last?.status || (test.status === 'skipped' ? 'skipped' : null);
          const file = spec.file || suite.file || '';
          const line = spec.line || 0;
          const column = spec.column || 0;
          const title = [...suiteTitles, spec.title].filter(Boolean).join(' › ');
          found.push({
            key: [test.projectName || '', file, line, column, title].join('|'),
            project: test.projectName || '', file, line, column, title, status,
            overallStatus: test.status || status,
            expectedStatus: test.expectedStatus || null,
            retryCount: Math.max(0, results.length - 1),
            durationMs: last?.duration ?? null,
            errors: (last?.errors || []).map(item => item.message || String(item))
          });
        }
      }
      visit(suite.suites, suiteTitles);
    }
  }
  visit(report.suites);
  return found;
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

try {
  console.log('[1/5] Discovering the complete Playwright browser inventory.');
  const listing = run(['--list', '--reporter=list'], { timeout: 180_000 });
  fs.writeFileSync(path.join(reportRoot, 'playwright-list.stdout.txt'), listing.stdout || '');
  fs.writeFileSync(path.join(reportRoot, 'playwright-list.stderr.txt'), listing.stderr || '');
  if (listing.status !== 0) throw new Error('Playwright --list failed with exit code ' + listing.status);
  const entries = (listing.stdout || '').split(/\r?\n/)
    .map(line => line.match(/^\s*(\[[^\]]+\] › [^\s]+\.spec\.js:\d+:\d+ › .*)$/)?.[1])
    .filter(Boolean);
  if (!entries.length) throw new Error('Playwright --list produced no recognized test-list entries.');
  const delegated = [];
  const scheduled = [];
  for (const entry of entries) {
    const matches = delegatedTitles.filter(title => entry.includes('› ' + title));
    if (matches.length > 1) throw new Error('A test matched multiple delegation rules: ' + entry);
    if (matches.length) delegated.push({ title: matches[0], entry });
    else scheduled.push(entry);
  }
  for (const title of delegatedTitles) {
    const count = delegated.filter(item => item.title === title).length;
    if (count !== 1) throw new Error('Expected exactly one delegated test "' + title + '", found ' + count);
  }
  if (scheduled.length + delegated.length !== entries.length) throw new Error('Browser inventory accounting mismatch.');
  fs.writeFileSync(listPath, scheduled.join('\n') + '\n');
  const sourceCommit = process.env.BLB_CONCURRENCY_SOURCE_SHA || process.env.GITHUB_SHA || 'unknown';
  const scheduledDigest = crypto.createHash('sha256').update(JSON.stringify(scheduled)).digest('hex');
  const inventoryPath = path.join(reportRoot, 'inventory.json');
  const priorInventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) : null;
  const priorInventoryMatches = priorInventory?.sourceCommit === sourceCommit &&
    priorInventory?.scheduledDigest === scheduledDigest && priorInventory?.scheduled === scheduled.length;
  if (priorInventory && !priorInventoryMatches) {
    for (const name of ['serial-results.json', 'serial-errors.json', 'serial-checkpoint.json',
      'serial-stage-summary.json', 'scheduled-test-list.txt',
      ...[1, 2, 3].flatMap(round => ['parallel-round-' + round + '-summary.json', 'parallel-round-' + round + '-results.json'])]) {
      fs.rmSync(path.join(reportRoot, name), { force: true });
    }
    console.log('Discarded prior concurrency evidence because its source commit or exact inventory fingerprint differs.');
  }
  writeJson(inventoryPath, {
    sourceCommit, scheduledDigest,
    discovered: entries.length, delegated: delegated.length, scheduled: scheduled.length,
    delegatedTests: delegated, scheduledTests: scheduled
  });
  console.log('Discovered ' + entries.length + '; delegated to dedicated workflows ' + delegated.length + '; comparison inventory ' + scheduled.length + '.');

  const mode = process.env.BLB_CONCURRENCY_MODE || 'full';
  const stageModes = ['stage-serial', 'stage-parallel'];
  if (!['screen', 'full', ...stageModes].includes(mode)) throw new Error('Unknown BLB_CONCURRENCY_MODE: ' + mode);

  if (mode === 'stage-serial') {
    console.log('[2/2] Running checkpointed isolated serial baseline.');
    const serialResultsPath = path.join(reportRoot, 'serial-results.json');
    const serialErrorsPath = path.join(reportRoot, 'serial-errors.json');
    let serial = fs.existsSync(serialResultsPath) ? JSON.parse(fs.readFileSync(serialResultsPath, 'utf8')) : [];
    let serialErrors = fs.existsSync(serialErrorsPath) ? JSON.parse(fs.readFileSync(serialErrorsPath, 'utf8')) : [];
    const serialKeys = new Set();
    const restoredCheckpointValid = priorInventoryMatches && serial.length <= scheduled.length &&
      serialErrors.length === 0 && serial.every((record, index) => {
        const test = record.tests?.[0];
        if (record.inventoryEntry !== scheduled[index] || record.exitCode !== 0 ||
            record.parseError || record.tests?.length !== 1 || !test?.key || !test.status ||
            serialKeys.has(test.key)) return false;
        serialKeys.add(test.key);
        return true;
      });
    if (serial.length > scheduled.length || serialErrors.length > 0 || (serial.length > 0 && !restoredCheckpointValid)) {
      serial = [];
      serialErrors = [];
      fs.rmSync(serialResultsPath, { force: true });
      fs.rmSync(serialErrorsPath, { force: true });
      fs.rmSync(path.join(reportRoot, 'serial-checkpoint.json'), { force: true });
      console.log('Discarded incomplete or invalid serial checkpoint; restarting the baseline from test 1.');
    }
    const batchSize = Number(process.env.BLB_CONCURRENCY_SERIAL_BATCH_SIZE || scheduled.length);
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('BLB_CONCURRENCY_SERIAL_BATCH_SIZE must be a positive integer.');
    const batchStart = serial.length;
    const batchEnd = Math.min(scheduled.length, batchStart + batchSize);
    const serialStartedAt = Date.now();
    const serialCheckpointPath = path.join(reportRoot, 'serial-checkpoint.json');
    const scheduledPath = path.join(reportRoot, 'scheduled-test-list.txt');
    fs.writeFileSync(scheduledPath, scheduled.join('\n') + '\n');
    console.log('Serial checkpoint batch [' + batchStart + '/' + scheduled.length + ' → ' + batchEnd + '/' + scheduled.length + '].');
    for (let index = batchStart; index < batchEnd; index++) {
      const oneTestPath = path.join(tempRoot, 'one-test.txt');
      fs.writeFileSync(oneTestPath, scheduled[index] + '\n');
      const logPath = path.join(reportRoot, 'serial-' + String(index + 1).padStart(4, '0') + '.log');
      const result = run(['--test-list', oneTestPath, '--workers=1', '--max-failures=0', '--reporter=json'], { timeout: 180_000 });
      fs.writeFileSync(logPath, (result.stdout || '') + '\n--- STDERR ---\n' + (result.stderr || ''));
      let tests = [];
      let parseError = null;
      try { tests = collectTests(parseJsonReport(result.stdout || '', 'serial test ' + (index + 1))); }
      catch (error) { parseError = error.message; }
      const record = {
        inventoryEntry: scheduled[index], exitCode: result.status, signal: result.signal || null,
        timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'), tests, parseError
      };
      serial.push(record);
      const bad = result.status !== 0 || tests.length !== 1 || !tests[0].status || parseError;
      if (bad) serialErrors.push({ index: index + 1, entry: scheduled[index], exitCode: result.status,
        signal: result.signal, parseError, observedTests: tests.length, status: tests[0]?.status || null });
      writeJson(serialCheckpointPath, {
        completed: serial.length, scheduled: scheduled.length, batchStart, batchEnd,
        elapsedMs: Date.now() - serialStartedAt, serialErrors, records: serial
      });
      writeJson(serialResultsPath, serial);
      writeJson(serialErrorsPath, serialErrors);
      if (bad) {
        console.log('Serial baseline stopped at first anomaly [' + (index + 1) + '/' + scheduled.length + '].');
        break;
      }
      if ((serial.length % 10 === 0) || index + 1 === batchEnd) {
        const elapsedMs = Date.now() - serialStartedAt;
        const averageMs = elapsedMs / Math.max(1, index + 1 - batchStart);
        const remainingMinutes = Math.ceil((scheduled.length - serial.length) * averageMs / 60_000);
        console.log('Serial baseline [' + serial.length + '/' + scheduled.length + '] | batch elapsed=' + Math.round(elapsedMs / 60_000) + 'm | estimated remaining=' + remainingMinutes + 'm | anomalies=' + serialErrors.length);
      }
    }
    const batchComplete = serialErrors.length === 0 && serial.length === batchEnd;
    const complete = serial.length === scheduled.length && serialErrors.length === 0;
    writeJson(path.join(reportRoot, 'serial-stage-summary.json'), {
      complete, batchComplete, batchStart, batchEnd, scheduledTestCount: scheduled.length,
      serialProcessCount: serial.length, serialAnomalies: serialErrors,
      elapsedMs: Date.now() - serialStartedAt
    });
    console.log('Serial stage batch: ' + JSON.stringify({
      batchComplete, complete, completed: serial.length, scheduled: scheduled.length,
      batchStart, batchEnd, anomalies: serialErrors.length, reusedSerialCheckpoint: restoredCheckpointValid
    }));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'complete=' + String(complete) + '\n');
    if (!batchComplete) process.exitCode = 1;
  } else if (mode === 'stage-parallel') {
    const repetition = Number(process.env.BLB_CONCURRENCY_REPETITION || 0);
    if (![1, 2, 3].includes(repetition)) throw new Error('BLB_CONCURRENCY_REPETITION must be 1, 2, or 3.');
    const inventoryPath = path.join(reportRoot, 'inventory.json');
    const serialPath = path.join(reportRoot, 'serial-results.json');
    const scheduledPath = path.join(reportRoot, 'scheduled-test-list.txt');
    if (![inventoryPath, serialPath, scheduledPath].every(file => fs.existsSync(file))) {
      throw new Error('Parallel stage is missing the serial-baseline artifact files.');
    }
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    const serial = JSON.parse(fs.readFileSync(serialPath, 'utf8'));
    const stageScheduled = fs.readFileSync(scheduledPath, 'utf8').split(/\r?\n/).filter(Boolean);
    if (JSON.stringify(stageScheduled) !== JSON.stringify(scheduled)) {
      throw new Error('Downloaded serial baseline inventory does not exactly match the current checked-out test inventory.');
    }
    if (inventory.sourceCommit !== sourceCommit || inventory.scheduledDigest !== scheduledDigest ||
        serial.length !== stageScheduled.length || inventory.scheduled !== stageScheduled.length) {
      throw new Error('Serial baseline artifact is incomplete or does not match the current source commit and exact inventory fingerprint.');
    }
    const serialByKey = new Map();
    for (const record of serial) {
      if (record.exitCode !== 0 || record.parseError || record.tests?.length !== 1) {
        throw new Error('Serial baseline contains a failed or malformed test record.');
      }
      const test = record.tests[0];
      if (serialByKey.has(test.key)) throw new Error('Serial baseline contains duplicate test identity: ' + test.key);
      serialByKey.set(test.key, test);
    }
    const reusableSummaryPath = path.join(reportRoot, 'parallel-round-' + repetition + '-summary.json');
    const reusableResultsPath = path.join(reportRoot, 'parallel-round-' + repetition + '-results.json');
    let reused = false;
    if (priorInventoryMatches && fs.existsSync(reusableSummaryPath) && fs.existsSync(reusableResultsPath)) {
      try {
        const priorSummary = JSON.parse(fs.readFileSync(reusableSummaryPath, 'utf8'));
        const priorResults = JSON.parse(fs.readFileSync(reusableResultsPath, 'utf8'));
        const priorByKey = new Map();
        let duplicatePriorIdentity = false;
        for (const test of priorResults.tests || []) {
          if (priorByKey.has(test.key)) duplicatePriorIdentity = true;
          priorByKey.set(test.key, test);
        }
        const priorEquivalent = !duplicatePriorIdentity && priorByKey.size === serialByKey.size &&
          [...serialByKey].every(([key, serialTest]) => {
            const parallelTest = priorByKey.get(key);
            return parallelTest && serialTest.status === parallelTest.status &&
              serialTest.overallStatus === parallelTest.overallStatus &&
              serialTest.expectedStatus === parallelTest.expectedStatus &&
              serialTest.retryCount === parallelTest.retryCount;
          });
        reused = priorSummary.complete === true && priorSummary.repetition === repetition &&
          priorSummary.sourceCommit === sourceCommit && priorSummary.scheduledDigest === scheduledDigest &&
          priorSummary.scheduledTestCount === stageScheduled.length &&
          priorSummary.observedTestCount === stageScheduled.length &&
          priorResults.repetition === repetition && priorResults.exitCode === 0 &&
          !priorResults.parseError && Array.isArray(priorResults.tests) &&
          priorResults.tests.length === stageScheduled.length && priorEquivalent;
      } catch { reused = false; }
    }
    if (reused) {
      console.log('Reusing verified parallel repetition ' + repetition + '/3 from a matching source commit and inventory; no browser tests rerun.');
    } else {
      console.log('[1/2] Running complete four-worker repetition ' + repetition + '/3 (fail fast).');
      const listPathForStage = path.join(reportRoot, 'scheduled-test-list.txt');
      const result = run(['--test-list', listPathForStage, '--workers=4', '--max-failures=1', '--reporter=json'], { timeout: 21_000_000 });
      fs.writeFileSync(path.join(reportRoot, 'parallel-round-' + repetition + '.log'),
        (result.stdout || '') + '\n--- STDERR ---\n' + (result.stderr || ''));
      let tests = [];
      let parseError = null;
      try { tests = collectTests(parseJsonReport(result.stdout || '', 'parallel repetition ' + repetition)); }
      catch (error) { parseError = error.message; }
      const parallelByKey = new Map();
      const duplicates = [];
      for (const test of tests) {
        if (parallelByKey.has(test.key)) duplicates.push(test.key);
        parallelByKey.set(test.key, test);
      }
      const missing = [...serialByKey.keys()].filter(key => !parallelByKey.has(key));
      const extra = [...parallelByKey.keys()].filter(key => !serialByKey.has(key));
      const mismatches = [];
      for (const [key, serialTest] of serialByKey) {
        const parallelTest = parallelByKey.get(key);
        if (parallelTest && (serialTest.status !== parallelTest.status ||
            serialTest.overallStatus !== parallelTest.overallStatus ||
            serialTest.expectedStatus !== parallelTest.expectedStatus ||
            serialTest.retryCount !== parallelTest.retryCount)) {
          mismatches.push({ key, serial: {
            status: serialTest.status, overallStatus: serialTest.overallStatus,
            expectedStatus: serialTest.expectedStatus, retryCount: serialTest.retryCount
          }, parallel: {
            status: parallelTest.status, overallStatus: parallelTest.overallStatus,
            expectedStatus: parallelTest.expectedStatus, retryCount: parallelTest.retryCount
          }});
        }
      }
      const complete = result.status === 0 && !parseError && tests.length === stageScheduled.length &&
        missing.length === 0 && extra.length === 0 && duplicates.length === 0 && mismatches.length === 0;
      const summary = {
        sourceCommit, scheduledDigest, repetition,
        scheduledTestCount: stageScheduled.length, observedTestCount: tests.length,
        exitCode: result.status, timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
        parseError, missing, extra, duplicates, statusMismatches: mismatches, complete
      };
      writeJson(path.join(reportRoot, 'parallel-round-' + repetition + '-results.json'), { repetition, exitCode: result.status, tests, parseError });
      writeJson(path.join(reportRoot, 'parallel-round-' + repetition + '-summary.json'), summary);
      console.log('Parallel stage ' + repetition + '/3: ' + JSON.stringify({
        complete, observed: tests.length, expected: stageScheduled.length, missing: missing.length,
        extra: extra.length, duplicates: duplicates.length, mismatches: mismatches.length, exitCode: result.status
      }));
      if (!complete) process.exitCode = 1;
  
    }
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'reused=' + String(reused) + '\n');
  } else if (mode === 'screen') {
    console.log('[2/2] Running one complete four-worker screening pass (fail fast).');
    const result = run(['--test-list', listPath, '--workers=4', '--max-failures=1', '--reporter=json'], { timeout: 21_000_000 });
    fs.writeFileSync(path.join(reportRoot, 'screening.log'), (result.stdout || '') + '\n--- STDERR ---\n' + (result.stderr || ''));
    let tests = [];
    let parseError = null;
    try { tests = collectTests(parseJsonReport(result.stdout || '', 'four-worker screening')); }
    catch (error) { parseError = error.message; }
    const byKey = new Map();
    const duplicates = [];
    for (const test of tests) {
      if (byKey.has(test.key)) duplicates.push(test.key);
      byKey.set(test.key, test);
    }
    const expected = new Set(scheduled.map(entry => {
      const match = entry.match(/^\s*\[([^\]]+)\] › ([^\s]+\.spec\.js):(\d+):(\d+) › (.*)$/);
      return match ? [match[1], match[2], Number(match[3]), Number(match[4]), path.basename(match[2]) + ' › ' + match[5]].join('|') : null;
    }).filter(Boolean));
    const missing = [...expected].filter(key => !byKey.has(key));
    const extra = [...byKey.keys()].filter(key => !expected.has(key));
    const failures = tests.filter(test => test.overallStatus !== 'expected' && test.status !== 'skipped');
    const summary = {
      mode, discoveredTestCount: entries.length, delegatedTestCount: delegated.length,
      scheduledTestCount: scheduled.length, observedTestCount: tests.length,
      exitCode: result.status, timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
      parseError, missing, extra, duplicates, failures,
      complete: result.status === 0 && !parseError && tests.length === scheduled.length &&
        missing.length === 0 && extra.length === 0 && duplicates.length === 0 && failures.length === 0
    };
    writeJson(path.join(reportRoot, 'screening-summary.json'), summary);
    console.log('Screening summary: ' + JSON.stringify({
      complete: summary.complete, observed: summary.observedTestCount, expected: summary.scheduledTestCount,
      failures: failures.length, missing: missing.length, extra: extra.length, duplicates: duplicates.length,
      exitCode: result.status
    }));
    if (!summary.complete) process.exitCode = 1;
  } else {
  console.log('[2/5] Running the legacy one-test-per-process serial baseline.');
  const serial = [];
  const serialErrors = [];
  const serialStartedAt = Date.now();
  const serialCheckpointPath = path.join(reportRoot, 'serial-checkpoint.json');
  for (let index = 0; index < scheduled.length; index++) {
    const oneTestPath = path.join(tempRoot, 'one-test.txt');
    fs.writeFileSync(oneTestPath, scheduled[index] + '\n');
    const logPath = path.join(reportRoot, 'serial-' + String(index + 1).padStart(4, '0') + '.log');
    const result = run(['--test-list', oneTestPath, '--workers=1', '--max-failures=0', '--reporter=json'], { timeout: 180_000 });
    fs.writeFileSync(logPath, (result.stdout || '') + '\n--- STDERR ---\n' + (result.stderr || ''));
    let tests = [];
    let parseError = null;
    try { tests = collectTests(parseJsonReport(result.stdout || '', 'serial test ' + (index + 1))); }
    catch (error) { parseError = error.message; }
    const record = {
      inventoryEntry: scheduled[index], exitCode: result.status, signal: result.signal || null,
      timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'), tests, parseError
    };
    serial.push(record);
    writeJson(serialCheckpointPath, {
      completed: serial.length, scheduled: scheduled.length,
      elapsedMs: Date.now() - serialStartedAt, serialErrors, records: serial
    });
    if (result.status !== 0 || tests.length !== 1 || !tests[0].status || parseError) {
      serialErrors.push({ index: index + 1, entry: scheduled[index], exitCode: result.status,
        signal: result.signal, parseError, observedTests: tests.length, status: tests[0]?.status || null });
      console.log('Serial baseline stopped at first anomaly [' + (index + 1) + '/' + scheduled.length + '].');
      break;
    }
    if ((index + 1) % 10 === 0 || index + 1 === scheduled.length) {
      const elapsedMs = Date.now() - serialStartedAt;
      const averageMs = elapsedMs / (index + 1);
      const remainingMinutes = Math.ceil((scheduled.length - index - 1) * averageMs / 60_000);
      console.log('Serial baseline [' + (index + 1) + '/' + scheduled.length + '] | elapsed=' + Math.round(elapsedMs / 60_000) + 'm | estimated remaining=' + remainingMinutes + 'm | anomalies=' + serialErrors.length);
    }
  }
  writeJson(path.join(reportRoot, 'serial-results.json'), serial);
  writeJson(path.join(reportRoot, 'serial-errors.json'), serialErrors);
  if (serial.length !== scheduled.length) throw new Error('Serial baseline did not produce one record per scheduled test.');
  console.log('Serial baseline complete: ' + serial.length + ' isolated Playwright processes; anomalies=' + serialErrors.length + '.');

  console.log('[3/5] Running the complete inventory with four workers, three independent repetitions.');
  const parallelRounds = [];
  for (let round = 1; round <= 3; round++) {
    const result = run(['--test-list', listPath, '--workers=4', '--max-failures=0', '--reporter=json'], { timeout: 21_000_000 });
    fs.writeFileSync(path.join(reportRoot, 'parallel-round-' + round + '.log'),
      (result.stdout || '') + '\n--- STDERR ---\n' + (result.stderr || ''));
    let tests = [];
    let parseError = null;
    try { tests = collectTests(parseJsonReport(result.stdout || '', 'parallel repetition ' + round)); }
    catch (error) { parseError = error.message; }
    const record = {
      repetition: round, exitCode: result.status, signal: result.signal || null,
      timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'), tests, parseError
    };
    parallelRounds.push(record);
    writeJson(path.join(reportRoot, 'parallel-round-' + round + '-results.json'), record);
    console.log('Parallel repetition [' + round + '/3]: observed=' + tests.length + '/' + scheduled.length +
      ', exit=' + result.status + ', parse=' + (parseError || 'ok'));
  }

  console.log('[4/5] Comparing exact test ownership and per-test outcomes.');
  const serialByKey = new Map();
  for (const record of serial) for (const test of record.tests) {
    if (serialByKey.has(test.key)) serialErrors.push({ key: test.key, issue: 'duplicate serial test identity' });
    serialByKey.set(test.key, test);
  }
  const comparisons = [];
  for (const round of parallelRounds) {
    const parallelByKey = new Map();
    const parallelDuplicates = [];
    for (const test of round.tests) {
      if (parallelByKey.has(test.key)) parallelDuplicates.push(test.key);
      parallelByKey.set(test.key, test);
    }
    const missing = [...serialByKey.keys()].filter(key => !parallelByKey.has(key));
    const extra = [...parallelByKey.keys()].filter(key => !serialByKey.has(key));
    const mismatches = [];
    for (const [key, serialTest] of serialByKey) {
      const parallelTest = parallelByKey.get(key);
      if (parallelTest && (
        serialTest.status !== parallelTest.status ||
        serialTest.overallStatus !== parallelTest.overallStatus ||
        serialTest.expectedStatus !== parallelTest.expectedStatus ||
        serialTest.retryCount !== parallelTest.retryCount
      )) {
        mismatches.push({ key, serial: {
          status: serialTest.status, overallStatus: serialTest.overallStatus,
          expectedStatus: serialTest.expectedStatus, retryCount: serialTest.retryCount
        }, parallel: {
          status: parallelTest.status, overallStatus: parallelTest.overallStatus,
          expectedStatus: parallelTest.expectedStatus, retryCount: parallelTest.retryCount
        }});
      }
    }
    comparisons.push({
      repetition: round.repetition, serialIdentities: serialByKey.size, parallelIdentities: parallelByKey.size,
      missing, extra, parallelDuplicates, statusMismatches: mismatches, parallelExitCode: round.exitCode, parallelParseError: round.parseError
    });
  }
  const final = {
    scheduledTestCount: scheduled.length, serialProcessCount: serial.length,
    serialCollectedTestCount: serialByKey.size, serialAnomalies: serialErrors,
    parallelRepetitions: comparisons,
    equivalent: serialErrors.length === 0 && serialByKey.size === scheduled.length &&
      comparisons.length === 3 && comparisons.every(item => item.parallelExitCode === 0 &&
        !item.parallelParseError && item.parallelIdentities === scheduled.length &&
        item.missing.length === 0 && item.extra.length === 0 && item.parallelDuplicates.length === 0 && item.statusMismatches.length === 0)
  };
  writeJson(path.join(reportRoot, 'comparison-summary.json'), final);
  console.log('[5/5] Comparison summary: ' + JSON.stringify({
    equivalent: final.equivalent, inventory: final.scheduledTestCount,
    serialProcesses: final.serialProcessCount, serialCollected: final.serialCollectedTestCount,
    serialAnomalies: final.serialAnomalies.length,
    parallel: final.parallelRepetitions.map(item => ({
      repetition: item.repetition, observed: item.parallelIdentities, missing: item.missing.length,
      extra: item.extra.length, duplicates: item.parallelDuplicates.length, statusMismatches: item.statusMismatches.length, exitCode: item.parallelExitCode
    }))
  }));
  if (!final.equivalent) process.exitCode = 1;
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
