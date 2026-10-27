#!/usr/bin/env node
/**
 * Conservative CI change classifier.
 *
 * Only changes that cannot affect extension behavior are exempt from the
 * expensive behavioral regression suites. Unknown paths are treated as runtime
 * changes. Packaging/manifest validation remains required regardless.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const base = process.argv[2];
if (!base || !/^[0-9a-f]{7,40}$/i.test(base)) {
  console.error("Usage: node scripts/classify-ci-changes.mjs <base-sha>");
  process.exit(2);
}

const run = (args) => execFileSync("git", args, { encoding: "utf8" }).trimEnd();
// Include deletions and type changes: removing runtime code can change behavior too.
const changed = run(["diff", "--name-only", "--diff-filter=ACDMRT", `${base}...${"HEAD"}`])
  .split("\n").filter(Boolean);

if (!changed.length) {
  console.log("No changed files detected; treating as non-runtime.");
}

function readAt(ref, path) {
  try { return run(["show", `${ref}:${path}`]); }
  catch { return null; }
}
function sameExceptVersion(path) {
  const before = readAt(base, path);
  const after = readAt("HEAD", path);
  if (before === null || after === null) return false;
  try {
    const a = JSON.parse(before);
    const b = JSON.parse(after);
    if (typeof a.version !== "string" || typeof b.version !== "string") return false;
    delete a.version;
    delete b.version;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}
function nonRuntimePath(path) {
  return /^(?:docs\/|README(?:\.|$)|LICENSE(?:\.|$)|CHANGELOG(?:\.|$)|CONTRIBUTING(?:\.|$)|\.github\/(?:workflows\/|ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\/)|tests\/selector\/|scripts\/(?:classify-ci-changes|select-browser-specs)\.mjs$|scripts\/test-ci-routing-selector\.js)/i.test(path)
    || /^tests\/browser\/[^/]+\.spec\.js$/i.test(path)
    || /^(store-assets\/|assets\/store\/|extension\/(icons|store-assets)\/)/i.test(path);
}

let runtimeChanged = false;
const reasons = [];
for (const path of changed) {
  if (nonRuntimePath(path)) continue;
  if ((path === "package.json" || path === "extension/manifest.json") && sameExceptVersion(path)) continue;
  runtimeChanged = true;
  reasons.push(path);
}

const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `runtime_changed=${runtimeChanged}\n`);
console.log(`runtime_changed=${runtimeChanged}`);
console.log(`changed_files=${changed.length}`);
if (reasons.length) console.log(`runtime_or_unknown_paths:\n- ${reasons.join("\n- ")}`);
