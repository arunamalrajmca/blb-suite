#!/usr/bin/env node
/**
 * Filter the reference workflow matrix before GitHub allocates runners.
 * scripts/reference-e2e-matrix.json is the single source of truth for entries.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function validateReferenceMatrix(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Reference matrix must contain entries");
  if (entries.some(entry => !entry || typeof entry.group !== "string" || !entry.group || typeof entry.grep !== "string")) {
    throw new Error("Every reference matrix entry must define group and grep");
  }
  if (entries.some(entry => entry.file !== undefined && typeof entry.file !== "string")) {
    throw new Error("Reference matrix file values must be strings when provided");
  }
  if (entries.some(entry => entry.files !== undefined && (!Array.isArray(entry.files) || entry.files.length === 0 || entry.files.some(file => typeof file !== "string" || !file) || entry.file !== undefined))) {
    throw new Error("Reference matrix files must be a non-empty string array and cannot be combined with file");
  }
  if (new Set(entries.map(entry => entry.group)).size !== entries.length) {
    throw new Error("Reference matrix group names must be unique");
  }
  return entries;
}

export function selectReferenceMatrix(entries, { full = false, changedSpecs = "", changedBrowserSpecs = "" } = {}) {
  validateReferenceMatrix(entries);
  if (full) return entries;
  const selected = new Set(String(changedSpecs).split(",").filter(Boolean));
  const changedBrowser = new Set(String(changedBrowserSpecs).split(",").filter(Boolean));
  return entries.filter(entry => {
    const specs = entry.files || [entry.file || "tests/browser/extension.spec.js"];
    // A batched entry is selected when any included spec changes. Generic
    // extension.spec entries remain excluded when that spec itself was edited
    // alongside runtime, matching the prior step-level predicate.
    return specs.some(spec => selected.has(spec)) &&
      (Boolean(entry.file || entry.files) || !changedBrowser.has("tests/browser/extension.spec.js"));
  });
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const matrixPath = resolve(here, "reference-e2e-matrix.json");
  const entries = validateReferenceMatrix(JSON.parse(readFileSync(matrixPath, "utf8")));
  const selected = selectReferenceMatrix(entries, {
    full: process.env.FULL_BROWSER_SUITE === "true",
    changedSpecs: process.env.CHANGED_SPECS || "",
    changedBrowserSpecs: process.env.CHANGED_BROWSER_SPECS || ""
  });
  const values = {
    reference_matrix: JSON.stringify(selected),
    reference_matrix_required: String(selected.length > 0),
    reference_matrix_count: String(selected.length)
  };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
