import fs from 'node:fs';
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
const selectedListPath = path.join(tempRoot, 'selected-browser-tests.txt');
const delegatedTitles = [
  'a real MV3 service-worker termination is recovered by the physical Alt+B browser shortcut',
  'native Chromium _self prerender activation initializes the activated document without tab replacement',
  'native Chromium _blank prerender activation initializes the activated document without tab replacement',
  'Show on BLB performance benchmark',
  'Interleaved baseline/candidate performance batch preserves isolated samples'
];
const riskPattern = /service.?worker|worker termination|lifecycle|navigation|permission|registration|content.?script|context.?menu|right.?click|alt\+b|shortcut|reload|restart|master.?toggle|opt.?in|opt.?out|race|startup|shutdown|tab close|tab removal|extension update|handshake|injection/i;

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, 'test', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 3_600_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...options.env }
  });
}

function parseJsonReport(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(label + ': Playwright JSON reporter output was not valid JSON: ' + error.message);
  }
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
          // Playwright includes the spec filename as the outermost suite title;
          // the inventory identity already carries the file separately.
          const title = [...suiteTitles.filter(value => value !== path.basename(file)), spec.title].filter(Boolean).join(' › ');
          found.push({
            key: [test.projectName || '', file, line, column, title].join('|'),
            project: test.projectName || '',
            file,
            line,
            column,
            title,
            status,
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

function parseInventoryEntry(entry) {
  const match = entry.match(/^\s*\[([^\]]+)\]\s+›\s+(.+?\.spec\.js):(\d+):(\d+)\s+›\s+(.*)$/);
  if (!match) return null;
  return {
    entry: entry.trim(),
    project: match[1],
    file: match[2],
    line: Number(match[3]),
    column: Number(match[4]),
    title: match[5]
  };
}

function selectRepresentativeInventory(entries) {
  const byFile = new Map();
  for (const item of entries) {
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push(item);
  }

  const selected = new Map();
  const fileSummary = [];
  for (const [file, tests] of byFile) {
    const reasons = new Map();
    const add = (test, reason) => {
      const current = reasons.get(test.entry) || [];
      current.push(reason);
      reasons.set(test.entry, current);
    };

    add(tests[0], 'first-test-in-spec');
    if (tests.length > 1) add(tests[tests.length - 1], 'last-test-in-spec');
    for (const test of tests) {
      if (riskPattern.test(test.title)) add(test, 'concurrency-sensitive-title');
    }

    for (const [entry, selectedReasons] of reasons) {
      const test = tests.find(candidate => candidate.entry === entry);
      selected.set(entry, { ...test, reasons: [...new Set(selectedReasons)] });
    }
    fileSummary.push({
      file,
      discovered: tests.length,
      selected: reasons.size,
      selectedTests: [...reasons.entries()].map(([entry, selectedReasons]) => ({
        entry,
        reasons: [...new Set(selectedReasons)]
      }))
    });
  }
  return { selected: [...selected.values()], fileSummary };
}

function runModel(label, listPath, workers, logPath, timeout) {
  const result = run([
    '--test-list', listPath,
    '--workers=' + workers,
    '--max-failures=0',
    '--reporter=json'
  ], { timeout });
  fs.writeFileSync(logPath, (result.stdout || '') + '\n--- STDERR ---\n' + (result.stderr || ''));
  let tests = [];
  let parseError = null;
  try {
    tests = collectTests(parseJsonReport(result.stdout || '', label));
  } catch (error) {
    parseError = error.message;
  }
  return {
    label,
    workers,
    exitCode: result.status,
    signal: result.signal || null,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    spawnError: result.error ? String(result.error.message || result.error) : null,
    tests,
    parseError
  };
}

try {
  console.log('[1/5] Discovering the complete Playwright browser inventory.');
  const listing = run(['--list', '--reporter=list'], { timeout: 180_000 });
  fs.writeFileSync(path.join(reportRoot, 'playwright-list.stdout.txt'), listing.stdout || '');
  fs.writeFileSync(path.join(reportRoot, 'playwright-list.stderr.txt'), listing.stderr || '');
  if (listing.status !== 0) throw new Error('Playwright --list failed with exit code ' + listing.status);

  const entries = (listing.stdout || '').split(/\r?\n/)
    .map(line => line.match(/^\s*(\[[^\]]+\]\s+›\s+.+?\.spec\.js:\d+:\d+\s+›\s+.*)$/)?.[1])
    .filter(Boolean);
  if (!entries.length) throw new Error('Playwright --list produced no recognized test-list entries.');

  const delegated = [];
  const comparisonInventory = [];
  for (const entry of entries) {
    const matches = delegatedTitles.filter(title => entry.includes('› ' + title));
    if (matches.length > 1) throw new Error('A test matched multiple delegation rules: ' + entry);
    if (matches.length) delegated.push({ title: matches[0], entry });
    else comparisonInventory.push(entry);
  }
  for (const title of delegatedTitles) {
    const count = delegated.filter(item => item.title === title).length;
    if (count !== 1) throw new Error('Expected exactly one delegated test "' + title + '", found ' + count);
  }
  if (comparisonInventory.length + delegated.length !== entries.length) {
    throw new Error('Browser inventory accounting mismatch.');
  }

  const parsed = comparisonInventory.map(parseInventoryEntry);
  if (parsed.some(item => !item)) {
    throw new Error('Could not parse one or more discovered browser inventory entries.');
  }
  const selection = selectRepresentativeInventory(parsed);
  if (!selection.selected.length) throw new Error('Representative browser inventory selection is empty.');
  fs.writeFileSync(selectedListPath, selection.selected.map(item => item.entry).join('\n') + '\n');

  const inventory = {
    discovered: entries.length,
    delegated: delegated.length,
    comparisonInventory: comparisonInventory.length,
    specFileCount: selection.fileSummary.length,
    selected: selection.selected.length,
    selectionPolicy: 'first and last test in every spec file, plus every test whose title matches the concurrency-sensitive risk pattern',
    delegatedTests: delegated,
    specFiles: selection.fileSummary,
    selectedTests: selection.selected
  };
  writeJson(path.join(reportRoot, 'inventory.json'), inventory);
  console.log('Discovered ' + entries.length + ' tests across ' + selection.fileSummary.length +
    ' spec files; delegated=' + delegated.length + '; selected=' + selection.selected.length +
    ' for serial/parallel comparison.');

  console.log('[2/5] Running the representative inventory in one serial Playwright process (one worker).');
  const serial = runModel(
    'serial baseline',
    selectedListPath,
    1,
    path.join(reportRoot, 'serial-one-worker.log'),
    3_600_000
  );
  writeJson(path.join(reportRoot, 'serial-results.json'), serial);
  console.log('Serial: observed=' + serial.tests.length + '/' + selection.selected.length +
    ', exit=' + serial.exitCode + ', parse=' + (serial.parseError || 'ok'));

  console.log('[3/5] Running the same representative inventory once with four workers.');
  const parallel = runModel(
    'four-worker comparison',
    selectedListPath,
    4,
    path.join(reportRoot, 'parallel-four-workers.log'),
    3_600_000
  );
  writeJson(path.join(reportRoot, 'parallel-results.json'), parallel);
  console.log('Parallel: observed=' + parallel.tests.length + '/' + selection.selected.length +
    ', exit=' + parallel.exitCode + ', parse=' + (parallel.parseError || 'ok'));

  console.log('[4/5] Comparing exact test identities, outcomes, and retry counts.');
  const serialByKey = new Map();
  const serialDuplicates = [];
  for (const test of serial.tests) {
    if (serialByKey.has(test.key)) serialDuplicates.push(test.key);
    serialByKey.set(test.key, test);
  }
  const parallelByKey = new Map();
  const parallelDuplicates = [];
  for (const test of parallel.tests) {
    if (parallelByKey.has(test.key)) parallelDuplicates.push(test.key);
    parallelByKey.set(test.key, test);
  }
  const missing = [...serialByKey.keys()].filter(key => !parallelByKey.has(key));
  const extra = [...parallelByKey.keys()].filter(key => !serialByKey.has(key));
  const statusMismatches = [];
  for (const [key, serialTest] of serialByKey) {
    const parallelTest = parallelByKey.get(key);
    if (parallelTest && (
      serialTest.status !== parallelTest.status ||
      serialTest.overallStatus !== parallelTest.overallStatus ||
      serialTest.expectedStatus !== parallelTest.expectedStatus ||
      serialTest.retryCount !== parallelTest.retryCount
    )) {
      statusMismatches.push({
        key,
        serial: {
          status: serialTest.status,
          overallStatus: serialTest.overallStatus,
          expectedStatus: serialTest.expectedStatus,
          retryCount: serialTest.retryCount
        },
        parallel: {
          status: parallelTest.status,
          overallStatus: parallelTest.overallStatus,
          expectedStatus: parallelTest.expectedStatus,
          retryCount: parallelTest.retryCount
        }
      });
    }
  }

  const expectedKeys = new Set(selection.selected.map(item =>
    [item.project, item.file, item.line, item.column, item.title].join('|')
  ));
  const serialMissing = [...expectedKeys].filter(key => !serialByKey.has(key));
  const parallelMissing = [...expectedKeys].filter(key => !parallelByKey.has(key));
  const final = {
    discoveredTestCount: entries.length,
    delegatedTestCount: delegated.length,
    comparisonInventoryCount: comparisonInventory.length,
    specFileCount: selection.fileSummary.length,
    selectedTestCount: selection.selected.length,
    serial: {
      exitCode: serial.exitCode,
      observed: serial.tests.length,
      uniqueIdentities: serialByKey.size,
      timedOut: serial.timedOut,
      parseError: serial.parseError
    },
    parallel: {
      exitCode: parallel.exitCode,
      observed: parallel.tests.length,
      uniqueIdentities: parallelByKey.size,
      timedOut: parallel.timedOut,
      parseError: parallel.parseError
    },
    serialDuplicates,
    parallelDuplicates,
    serialMissing,
    parallelMissing,
    missing,
    extra,
    statusMismatches,
    equivalent: serial.exitCode === 0 && parallel.exitCode === 0 &&
      !serial.parseError && !parallel.parseError &&
      serialByKey.size === selection.selected.length &&
      parallelByKey.size === selection.selected.length &&
      serialDuplicates.length === 0 && parallelDuplicates.length === 0 &&
      serialMissing.length === 0 && parallelMissing.length === 0 &&
      missing.length === 0 && extra.length === 0 && statusMismatches.length === 0
  };
  writeJson(path.join(reportRoot, 'comparison-summary.json'), final);

  console.log('[5/5] Comparison summary: ' + JSON.stringify({
    equivalent: final.equivalent,
    discovered: final.discoveredTestCount,
    specFiles: final.specFileCount,
    selected: final.selectedTestCount,
    serialObserved: final.serial.observed,
    parallelObserved: final.parallel.observed,
    missing: final.missing.length,
    extra: final.extra.length,
    statusMismatches: final.statusMismatches.length,
    serialExit: final.serial.exitCode,
    parallelExit: final.parallel.exitCode
  }));
  if (!final.equivalent) process.exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
