#!/usr/bin/env node
/**
 * Filter the reference workflow's declared matrix before GitHub allocates runners.
 * The matrix definition remains the single source of truth in the workflow YAML.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function parseReferenceMatrix(workflow) {
  const lines = workflow.split(/\r?\n/);
  const includeAt = lines.findIndex(line => /^\s{8}include:\s*$/.test(line));
  if (includeAt < 0) throw new Error("Reference workflow matrix include block was not found");
  const entries = [];
  let current = null;
  for (let i = includeAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{4}steps:\s*$/.test(line)) break;
    const groupMatch = line.match(/^\s{10}- group:\s*(.*?)\s*$/);
    if (groupMatch) {
      if (current) entries.push(current);
      current = { group: parseScalar(groupMatch[1]) };
      continue;
    }
    if (!current) continue;
    const fieldMatch = line.match(/^\s{12}(file|grep):\s*(.*?)\s*$/);
    if (fieldMatch) current[fieldMatch[1]] = parseScalar(fieldMatch[2]);
  }
  if (current) entries.push(current);
  if (!entries.length) throw new Error("Reference workflow matrix was empty or could not be parsed");
  if (entries.some(entry => !entry.group || !entry.grep)) {
    throw new Error("Every reference matrix entry must define group and grep");
  }
  if (new Set(entries.map(entry => entry.group)).size !== entries.length) {
    throw new Error("Reference matrix group names must be unique");
  }
  return entries;
}

function parseScalar(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

export function selectReferenceMatrix(entries, { full = false, changedSpecs = "", changedBrowserSpecs = "" } = {}) {
  if (full) return entries;
  const selected = new Set(String(changedSpecs).split(",").filter(Boolean));
  const changedBrowser = new Set(String(changedBrowserSpecs).split(",").filter(Boolean));
  return entries.filter(entry => {
    const spec = entry.file || "tests/browser/extension.spec.js";
    // Preserve the previous step-level predicate exactly: generic extension.spec
    // matrix entries are omitted when that spec itself was edited alongside runtime.
    return selected.has(spec) && (Boolean(entry.file) || !changedBrowser.has("tests/browser/extension.spec.js"));
  });
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const workflowPath = resolve(here, "../.github/workflows/browser-e2e-reference.yml");
  const entries = parseReferenceMatrix(readFileSync(workflowPath, "utf8"));
  const selected = selectReferenceMatrix(entries, {
    full: process.env.FULL_BROWSER_SUITE === "true",
    changedSpecs: process.env.CHANGED_SPECS || "",
    changedBrowserSpecs: process.env.CHANGED_BROWSER_SPECS || ""
  });
  const output = process.env.GITHUB_OUTPUT;
  const values = {
    reference_matrix: JSON.stringify(selected),
    reference_matrix_required: String(selected.length > 0),
    reference_matrix_count: String(selected.length)
  };
  if (output) appendFileSync(output, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
