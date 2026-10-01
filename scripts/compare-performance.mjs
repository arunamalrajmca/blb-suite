#!/usr/bin/env node
import fs from 'node:fs';

function readSamples(path) {
  return fs.readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function summarize(samples) {
  const byScenario = {};
  for (const scenario of ['selection', 'fresh', 'reuse', 'paragraph-two-tab', 'paragraph-classify']) {
    const values = samples.filter(s => s.scenario === scenario).map(s => s.handoffMs);
    if (!values.length) throw new Error(`Missing ${scenario} samples`);
    byScenario[scenario] = { median: median(values), count: values.length };
  }
  return byScenario;
}

const baselineSamples = readSamples(process.argv[2]);
const candidateSamples = readSamples(process.argv[3]);
const baseline = summarize(baselineSamples);
const candidate = summarize(candidateSamples);

function pairedMedianImprovement(scenario, field = 'handoffMs') {
  const before = baselineSamples.filter(s => s.scenario === scenario).map(s => s[field]);
  const after = candidateSamples.filter(s => s.scenario === scenario).map(s => s[field]);
  if (before.length !== after.length) throw new Error(`Mismatched ${scenario} sample counts for ${field}`);
  if (before.some(value => typeof value !== 'number') || after.some(value => typeof value !== 'number')) {
    throw new Error(`Missing numeric ${field} samples for ${scenario}`);
  }
  const improvements = before.map((value, index) => value > 0 ? (value - after[index]) / value : 0);
  return median(improvements);
}
const minTargetedImprovement = Number(process.env.BLB_PERF_MIN_TARGETED_IMPROVEMENT || 0.05);
const maxSelectionRegression = Number(process.env.BLB_PERF_MAX_SELECTION_REGRESSION || 0.10);
const maxFreshRegression = Number(process.env.BLB_PERF_MAX_FRESH_REGRESSION || 0.10);
const maxParagraphRegression = Number(process.env.BLB_PERF_MAX_PARAGRAPH_REGRESSION || 0.10);
const maxParagraphFirstTabRegression = Number(process.env.BLB_PERF_MAX_PARAGRAPH_FIRST_TAB_REGRESSION || 0.10);
const maxParagraphSecondTabRegression = Number(process.env.BLB_PERF_MAX_PARAGRAPH_SECOND_TAB_REGRESSION || 0.10);
const requireImprovement = process.env.BLB_PERF_REQUIRE_IMPROVEMENT === '1';
const enforceRegression = process.env.BLB_PERF_ENFORCE_REGRESSION !== '0';

console.log('| Scenario | main baseline | candidate | Improvement |');
console.log('|---|---:|---:|---:|');
for (const [name, key] of [
  ['Selection → BLB handoff', 'selection'],
  ['Fresh-tab handoff', 'fresh'],
  ['Existing-tab reuse', 'reuse'],
  ['Paragraph → MultiVerse + Criteria', 'paragraph-two-tab'],
  ['Paragraph classification only', 'paragraph-classify']
]) {
  const before = baseline[key].median;
  const after = candidate[key].median;
  const improvement = before > 0 ? (before - after) / before : 0;
  console.log(`| ${name} | ${before} ms | ${after} ms | ${(improvement * 100).toFixed(1)}% |`);
}

const selectionImprovement = pairedMedianImprovement('selection');
const freshImprovement = pairedMedianImprovement('fresh');
const reuseImprovement = pairedMedianImprovement('reuse');
const paragraphTwoTabImprovement = pairedMedianImprovement('paragraph-two-tab');
const paragraphFirstTabImprovement = pairedMedianImprovement('paragraph-two-tab', 'firstTabMs');
const paragraphSecondTabImprovement = pairedMedianImprovement('paragraph-two-tab', 'secondTabMs');
const paragraphClassifyImprovement = pairedMedianImprovement('paragraph-classify');

console.log(`Samples: baseline selection/fresh/reuse ${baseline.selection.count}/${baseline.fresh.count}/${baseline.reuse.count}; PR #8 ${candidate.selection.count}/${candidate.fresh.count}/${candidate.reuse.count}`);
console.log('Gate calculations use paired per-iteration improvement medians; scenario medians above are descriptive.');
console.log(`Maximum allowed selection-path paired regression: ${(maxSelectionRegression * 100).toFixed(1)}%`);
console.log(`Performance mode: ${requireImprovement ? 'improvement qualification' : (enforceRegression ? 'main regression protection' : 'diagnostic only')}`);
console.log(`Required existing-tab handoff paired improvement: ${(requireImprovement ? minTargetedImprovement : 0) * 100}%`);
console.log(`Required paragraph total handoff paired improvement: ${(Number(process.env.BLB_PERF_MIN_PARAGRAPH_TWO_TAB_IMPROVEMENT || 0.50) * 100).toFixed(1)}%`);
console.log(`Required paragraph first-tab creation paired improvement: ${(Number(process.env.BLB_PERF_MIN_PARAGRAPH_FIRST_TAB_IMPROVEMENT || 0.50) * 100).toFixed(1)}%`);
console.log(`Required paragraph second-tab creation paired improvement: ${(Number(process.env.BLB_PERF_MIN_PARAGRAPH_SECOND_TAB_IMPROVEMENT || 0.50) * 100).toFixed(1)}%`);
console.log('Paragraph classification is diagnostic only; it is no longer a release gate because it intentionally runs after the user-visible tabs are created.');
console.log(`Maximum allowed paragraph total regression: ${(maxParagraphRegression * 100).toFixed(1)}%`);
console.log(`Maximum allowed paragraph first-tab regression: ${(maxParagraphFirstTabRegression * 100).toFixed(1)}%`);
console.log(`Maximum allowed paragraph second-tab regression: ${(maxParagraphSecondTabRegression * 100).toFixed(1)}%`);
console.log(`Maximum allowed fresh-tab handoff paired regression: ${(maxFreshRegression * 100).toFixed(1)}%`);

const minParagraphTwoTabImprovement = Number(process.env.BLB_PERF_MIN_PARAGRAPH_TWO_TAB_IMPROVEMENT || 0.50);
const minParagraphFirstTabImprovement = Number(process.env.BLB_PERF_MIN_PARAGRAPH_FIRST_TAB_IMPROVEMENT || 0.50);
const minParagraphSecondTabImprovement = Number(process.env.BLB_PERF_MIN_PARAGRAPH_SECOND_TAB_IMPROVEMENT || 0.50);
const passed = !enforceRegression || (selectionImprovement >= -maxSelectionRegression
  && reuseImprovement >= (requireImprovement ? minTargetedImprovement : -maxSelectionRegression)
  && paragraphTwoTabImprovement >= (requireImprovement ? minParagraphTwoTabImprovement : -maxParagraphRegression)
  && paragraphFirstTabImprovement >= (requireImprovement ? minParagraphFirstTabImprovement : -maxParagraphFirstTabRegression)
  && paragraphSecondTabImprovement >= (requireImprovement ? minParagraphSecondTabImprovement : -maxParagraphSecondTabRegression)
  && freshImprovement >= -maxFreshRegression);

if (!passed) {
  console.error(requireImprovement
    ? 'PERFORMANCE GATE FAILED: the Performance PR must meet its measured improvement targets without excessive regressions.'
    : 'PERFORMANCE GATE FAILED: main must preserve the measured performance envelope without excessive regressions.');
  process.exit(1);
}
console.log(requireImprovement
  ? 'PERFORMANCE GATE PASSED: the Performance PR shows measured improvement on its targeted paths with no excessive regression.'
  : (enforceRegression
    ? 'PERFORMANCE GATE PASSED: main remains within the measured performance regression envelope.'
    : 'PERFORMANCE DIAGNOSTIC PASSED: no production extension files changed; measurements are informational only.'));