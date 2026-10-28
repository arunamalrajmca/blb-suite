#!/usr/bin/env node
/**
 * Exercise CI browser-suite routing against synthetic git diffs.
 * This catches regressions in the selector without requiring browser installs.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const selector = path.join(__dirname, 'select-browser-specs.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-ci-routing-'));
const run = (args, options = {}) => cp.execFileSync(args[0], args.slice(1), {
  cwd: options.cwd || temp,
  encoding: 'utf8',
  env: { ...process.env, ...(options.env || {}) },
  stdio: options.stdio || 'pipe'
});
const write = (relative, value = '// fixture\n') => {
  const file = path.join(temp, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
const commit = (message) => {
  run(['git', 'add', '-A']);
  run(['git', '-c', 'user.name=CI Routing Test', '-c', 'user.email=ci-routing@example.invalid', 'commit', '-m', message]);
  return run(['git', 'rev-parse', 'HEAD']).trim();
};
const resetScenario = (base) => {
  run(['git', 'reset', '--hard', base]);
  run(['git', 'clean', '-fd']);
};
const selectorResult = (base) => {
  const output = run([process.execPath, selector, base], {
    env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' }
  });
  const values = Object.fromEntries(output.split(/\r?\n/).filter(line => /^[a-z_]+=/.test(line))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
  return { output, values };
};
const assertValue = (result, key, value, scenario) => {
  assert.equal(result.values[key], String(value), scenario + ': ' + key + ' expected ' + value + ', got ' + result.values[key] + '\n' + result.output);
};

try {
  run(['git', 'init', '-q']);
  run(['git', 'config', 'user.name', 'CI Routing Test']);
  run(['git', 'config', 'user.email', 'ci-routing@example.invalid']);
  const fixtures = [
    'tests/browser/redirect-source-url-patterns.spec.js',
    'tests/browser/redirect-source-url-browser.spec.js',
    'tests/browser/redirect-hostnames.spec.js',
    'tests/browser/blb-non-kjv-redirect.spec.js',
    'tests/browser/scripttagger-global-injection.spec.js',
    'tests/browser/e2e-core-user-actions.spec.js',
    'tests/browser/multiverse-tab-reuse.spec.js',
    'tests/browser/site-feature-defaults.spec.js',
    'tests/browser/study-session-popup-ui-regression.spec.js',
    'tests/browser/study-backup-restore.spec.js',
    'tests/browser/feature-lifecycle-regressions.spec.js',
    'tests/browser/extension.spec.js',
    'tests/browser/shared-regex-patterns.spec.js',
    'tests/browser/rediscover-sagacity-button.spec.js',
    'tests/browser/research-dom-smoke.spec.js',
    'tests/browser/omnibox-boolean-operators.spec.js',
    'tests/browser/kings-bible-collector-behavior.spec.js',
    'tests/browser/webster-collector-behavior.spec.js',
    'tests/browser/case-sensitive-routing-behavior.spec.js',
    'tests/browser/performance.spec.js',
    'tests/browser/test-only.spec.js'
  ];
  for (const file of fixtures) write(file);
  write('extension/kjv-case-sensitive-words.js');
  write('extension/kings-bible-collector.js');
  write('extension/webster-collector.js');
  write('extension/multiverse-tool-view.js');
  write('extension/blb-parse-popup.js');
  write('extension/blb-verse-link-navigation.js');
  write('extension/redirect-bibleref-ranges.js');
  write('extension/redirect-christianity-main-world.js');
  write('extension/redirect-scripttagger.js');
  write('extension/popup.html');
  write('extension/popup.js');
  write('extension/background.js');
  write('extension/content.js');
  write('extension/reference-core.js');
  write('extension/book-aliases.js');
  write('extension/unmapped-feature.js');
  const base = commit('base fixture');

  // A mapped production feature should select only its declared E2E specs.
  resetScenario(base);
  write('extension/redirect-bibleref-ranges.js', '// changed redirect adapter\n');
  commit('change mapped redirect feature');
  let result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'mapped feature');
  assert(result.values.changed_specs.includes('redirect-source-url-patterns.spec.js'));
  assert(!result.values.changed_specs.includes('popup'), 'mapped feature should not pull in unrelated popup tests');
  console.log('PASS: mapped feature selects focused browser coverage');

  // The extracted Kings Bible collector should select its existing behavior suite only.
  resetScenario(base);
  write('extension/kings-bible-collector.js', '// changed Kings Bible feature\\n');
  commit('change Kings Bible collector feature');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'Kings Bible feature');
  assert(result.values.changed_specs.includes('kings-bible-collector-behavior.spec.js'));
  assert(!result.values.changed_specs.includes('popup'), 'Kings feature should not pull in unrelated popup tests');
  console.log('PASS: Kings Bible collector selects focused browser coverage');

  // Webster's collector has dedicated behavior coverage and should not trigger unrelated suites.
  resetScenario(base);
  write('extension/webster-collector.js', '// changed Webster collector\\n');
  commit('change Webster collector');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'Webster collector');
  assert(result.values.changed_specs.includes('webster-collector-behavior.spec.js'));
  assert(!result.values.changed_specs.includes('popup'), 'Webster collector should not pull in unrelated popup tests');
  assertValue(result, 'group_a_required', true, 'Webster collector');
  assertValue(result, 'group_b_required', false, 'Webster collector');
  assertValue(result, 'reference_required', false, 'Webster collector');
  console.log('PASS: Webster collector selects focused browser coverage');


  // The generated case-sensitive word set now has live MV3 routing coverage.
  // Its edits should run the focused case-sensitive browser spec, not the full suite.
  resetScenario(base);
  write('extension/kjv-case-sensitive-words.js', '// changed generated KJV case-sensitive word set\\n');
  commit('change generated KJV case-sensitive word set');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'KJV case-sensitive word set');
  assert(result.values.changed_specs.includes('tests/browser/case-sensitive-routing-behavior.spec.js'),
    'KJV word-set changes must select the live browser routing regression');
  assertValue(result, 'group_a_required', true, 'KJV case-sensitive word set');
  assertValue(result, 'group_b_required', false, 'KJV case-sensitive word set');
  assertValue(result, 'reference_required', false, 'KJV case-sensitive word set');
  console.log('PASS: KJV case-sensitive word set selects focused browser routing coverage');

  // Criteria Search navigation selects the full core user-action spec, which Group A runs once.
  resetScenario(base);
  write('extension/criteria-search-navigation.js', '// changed Criteria Search navigation\\n');
  commit('change Criteria Search navigation');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'Criteria Search navigation');
  assert(result.values.changed_specs.includes('tests/browser/e2e-core-user-actions.spec.js'));
  assertValue(result, 'group_a_required', true, 'Criteria Search navigation');
  assertValue(result, 'group_b_required', false, 'Criteria Search navigation');
  assertValue(result, 'reference_required', false, 'Criteria Search navigation');
  console.log('PASS: core user-action coverage is assigned to Group A only');

  // A popup-only feature stays focused as well.
  resetScenario(base);
  write('extension/popup.js', '// changed popup feature\n');
  commit('change popup feature');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'popup feature');
  assert(result.values.changed_specs.includes('site-feature-defaults.spec.js'));
  console.log('PASS: popup feature selects its mapped regression coverage');

  // Newly extracted feature modules select their established focused browser coverage.
  const extractedFeatureCases = [
    ['extension/multiverse-copy.js', 'multiverse-tab-reuse.spec.js'],
    ['extension/multiverse-tool-view.js', 'e2e-core-user-actions.spec.js'],
    ['extension/blb-parse-popup.js', 'e2e-core-user-actions.spec.js'],
    ['extension/blb-verse-link-navigation.js', 'e2e-core-user-actions.spec.js'],
    ['extension/study-reference-capture.js', 'feature-lifecycle-regressions.spec.js'],
    ['extension/criteria-search-navigation.js', 'e2e-core-user-actions.spec.js'],
    ['extension/blb-auto-hyperlinker.js', 'blb-auto-hyperlinker.spec.js'],
    ['extension/blb-passive-new-tab-targets.js', 'e2e-core-user-actions.spec.js'],
    ['extension/blb-draggable-button.js', 'blb-draggable-button.spec.js']
  ];
  for (const [file, expectedSpec] of extractedFeatureCases) {
    resetScenario(base);
    write(file, '// changed extracted feature module\n');
    commit('change extracted feature module ' + path.basename(file));
    result = selectorResult(base);
    assertValue(result, 'full_browser_suite', false, file);
    assert(result.values.changed_specs.includes(expectedSpec),
      file + ' should select ' + expectedSpec + ', got ' + result.values.changed_specs);
    console.log('PASS: ' + path.basename(file) + ' selects focused browser coverage');
  }

  // Shared runtime/bootstrap changes must force the full applicable suite.
  resetScenario(base);
  write('extension/reference-core.js', '// shared-core change\n');
  commit('change shared core');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', true, 'shared core');
  console.log('PASS: shared-core changes force broad browser coverage');

  // Unknown runtime files must not silently receive narrow coverage.
  resetScenario(base);
  write('extension/unmapped-feature.js', '// new unknown runtime feature\n');
  commit('change unmapped runtime');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', true, 'unknown runtime');
  console.log('PASS: unknown runtime changes force broad browser coverage');

  // Mixed mapped and shared changes remain broad.
  resetScenario(base);
  write('extension/redirect-bibleref-ranges.js', '// mapped change\n');
  write('extension/content.js', '// shared content change\n');
  commit('mixed mapped and shared change');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', true, 'mixed changes');
  console.log('PASS: mixed feature/shared changes force broad browser coverage');

  // Deleting a mapped feature still selects that feature's tests.
  resetScenario(base);
  fs.unlinkSync(path.join(temp, 'extension/redirect-bibleref-ranges.js'));
  commit('delete mapped feature file');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'deleted mapped feature');
  assert(result.values.changed_specs.includes('redirect-source-url-patterns.spec.js'));
  console.log('PASS: deleted mapped files retain feature coverage');

  // Browser-spec-only edits must not trigger the browser suite by themselves.
  resetScenario(base);
  write('tests/browser/test-only.spec.js', '// test-only edit\n');
  commit('change browser test only');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'browser test only');
  assert.equal(result.values.changed_specs, '', 'browser test-only changes should not select production E2E');
  console.log('PASS: browser-spec-only edits do not trigger feature E2E');

  // Focused behavior spec-only edits are handled by their dedicated workflow, not broad E2E groups.
  resetScenario(base);
  write('tests/browser/case-sensitive-routing-behavior.spec.js', '// focused test edit\\n');
  commit('change focused case-sensitive behavior test');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'focused behavior spec only');
  assertValue(result, 'group_a_required', false, 'focused behavior spec only');
  assertValue(result, 'group_b_required', false, 'focused behavior spec only');
  assertValue(result, 'reference_required', false, 'focused behavior spec only');
  assert.equal(result.values.changed_specs, '', 'focused test-only changes should not select broad E2E specs');
  console.log('PASS: focused behavior spec edits avoid broad E2E groups');

  // Mixed production + browser-spec edits must run the edited spec too.
  // Test-only edits stay skipped, but a runtime change must not silently skip
  // the regression test added alongside that runtime change.
  resetScenario(base);
  write('extension/book-aliases.js', '// runtime alias change\n');
  write('tests/browser/extension.spec.js', '// runtime regression test\n');
  commit('change runtime and related browser spec');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', true, 'runtime plus browser spec');
  assert(result.values.changed_browser_specs.includes('tests/browser/extension.spec.js'),
    'mixed runtime change must include its changed browser regression spec');
  console.log('PASS: mixed runtime and browser-spec changes run the edited regression spec');

  // CI selector infrastructure changes are validated by the package gate and must not launch browser E2E.
  resetScenario(base);
  write('scripts/select-browser-specs.mjs', '// selector infrastructure change\n');
  commit('change selector infrastructure');
  result = selectorResult(base);
  assertValue(result, 'full_browser_suite', false, 'selector infrastructure');
  console.log('PASS: selector infrastructure changes do not launch browser E2E');

  console.log('All CI routing selector contract checks passed.');
} catch (error) {
  console.error('FAIL: CI routing selector contract checks:', error.stack || error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
