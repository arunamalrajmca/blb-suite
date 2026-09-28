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

function pairedMedianImprovement(scenario) {
  const before = baselineSamples.filter(s => s.scenario === scenario).map(s => s.handoffMs);
  const after = candidateSamples.filter(s => s.scenario === scenario).map(s => s.handoffMs);
  if (before.length !== after.length) throw new Error(`Mismatched ${scenario} sample counts`);
  const improvements = before.map((value, index) => value > 0 ? (value - after[index]) / value : 0);
  return median(improvements);
}
const minTargetedImprovement = Number(process.env.BLB_PERF_MIN_TARGETED_IMPROVEMENT || 0.05);
const maxFreshRegression = Number(process.env.BLB_PERF_MAX_FRESH_REGRESSION || 0.10);

console.log('| Scenario | 5.2.51.43 baseline | PR #8 | Improvement |');
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
const paragraphClassifyImprovement = pairedMedianImprovement('paragraph-classify');

console.log(`Samples: baseline selection/fresh/reuse ${baseline.selection.count}/${baseline.fresh.count}/${baseline.reuse.count}; PR #8 ${candidate.selection.count}/${candidate.fresh.count}/${candidate.reuse.count}`);
console.log('Gate calculations use paired per-iteration improvement medians; scenario medians above are descriptive.');
console.log(`Required selection-path paired improvement: ${(minTargetedImprovement * 100).toFixed(1)}%`);
console.log(`Required existing-tab handoff paired improvement: ${(minTargetedImprovement * 100).toFixed(1)}%`);
console.log(`Required paragraph two-tab paired improvement: ${(Number(process.env.BLB_PERF_MIN_PARAGRAPH_TWO_TAB_IMPROVEMENT || 0.10) * 100).toFixed(1)}%`);
console.log(`Required paragraph classification paired improvement: ${(Number(process.env.BLB_PERF_MIN_PARAGRAPH_CLASSIFY_IMPROVEMENT || 0.10) * 100).toFixed(1)}%`);
console.log(`Maximum allowed fresh-tab handoff paired regression: ${(maxFreshRegression * 100).toFixed(1)}%`);

const minParagraphTwoTabImprovement = Number(process.env.BLB_PERF_MIN_PARAGRAPH_TWO_TAB_IMPROVEMENT || 0.10);
const minParagraphClassifyImprovement = Number(process.env.BLB_PERF_MIN_PARAGRAPH_CLASSIFY_IMPROVEMENT || 0.10);
const passed = selectionImprovement >= minTargetedImprovement
  && reuseImprovement >= minTargetedImprovement
  && paragraphTwoTabImprovement >= minParagraphTwoTabImprovement
  && paragraphClassifyImprovement >= minParagraphClassifyImprovement
  && freshImprovement >= -maxFreshRegression;

if (!passed) {
  console.error('PERFORMANCE GATE FAILED: the targeted selection, existing-tab handoff, and paragraph two-tab path must improve by the required amounts, and fresh-tab handoff must not regress excessively.');
  process.exit(1);
}
console.log('PERFORMANCE GATE PASSED: PR #8 has measured before/after improvement on the targeted paths with no excessive fresh-tab regression.');