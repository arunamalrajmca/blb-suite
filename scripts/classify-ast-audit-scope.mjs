#!/usr/bin/env node
/**
 * Select only repository-wide AST audits affected by a PR.
 * Unknown AST tooling changes and shared parser/dependency changes fail safe
 * to running every audit. Manual workflow_dispatch runs every audit.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const auditDefinitions = {
  symbol: ["scripts/ast-symbol-reference-audit.js", "scripts/ast-symbol-reference-audit.test.js"],
  repository: ["scripts/ast-repository-reachability-audit.js", "scripts/ast-repository-reachability-audit.test.js"],
  owner: ["scripts/ast-owner-aware-node-reachability-audit.js", "scripts/ast-owner-aware-node-reachability-audit.test.js"],
  cross_module: ["scripts/ast-cross-module-dynamic-reachability-audit.js", "scripts/ast-cross-module-dynamic-reachability-audit.test.js"],
  runtime: ["scripts/ast-runtime-flow-reachability-audit.js", "scripts/ast-runtime-flow-reachability-audit.test.js"],
  unified: ["scripts/ast-unified-dynamic-runtime-reachability-audit.js", "scripts/ast-unified-dynamic-runtime-reachability-audit.test.js"],
  computed: ["scripts/ast-computed-property-reachability-audit.js", "scripts/ast-computed-property-reachability-audit.test.js"],
  executable_source: ["scripts/ast-executable-source-coverage-audit.js", "scripts/ast-executable-source-coverage-audit.test.js"],
  metaprogramming: ["scripts/ast-runtime-metaprogramming-uncertainty-audit.js", "scripts/ast-runtime-metaprogramming-uncertainty-audit.test.js"]
};
const all = Object.keys(auditDefinitions);

export function selectAstAudits(changedPaths, { full = false } = {}) {
  const selected = new Set();
  if (full) return all;
  for (const path of changedPaths) {
    if (path === "package.json" || path === "package-lock.json"
      || path === "scripts/classify-ast-audit-scope.mjs"
      || path === "scripts/ast-shared-utils.js"
      || path === ".github/workflows/browser-tests.yml"
      || path.startsWith(".github/actions/ci-section-checkpoint/")) {
      return all;
    }
    let matched = false;
    for (const [name, paths] of Object.entries(auditDefinitions)) {
      if (paths.includes(path)) {
        selected.add(name);
        matched = true;
      }
    }
    // The cross-module and unified audits consume owner-aware module graph
    // behavior; unified also consumes runtime-flow semantics.
    if (path === auditDefinitions.owner[0] || path === auditDefinitions.owner[1]) {
      selected.add("cross_module");
      selected.add("unified");
    }
    if (path === auditDefinitions.runtime[0] || path === auditDefinitions.runtime[1]) {
      selected.add("unified");
    }
    // The cross-module audit imports resolveModuleFile from the unified
    // analyzer, so changes to that resolver must also exercise its consumer.
    if (path === auditDefinitions.unified[0] || path === auditDefinitions.unified[1]) {
      selected.add("cross_module");
    }
    // Any unclassified AST audit source/test could be a shared dependency.
    if (!matched && /^scripts\/ast-.*(?:\.js|\.mjs)$/.test(path)) return all;
  }
  return all.filter(name => selected.has(name));
}

if (process.argv[1]?.endsWith("classify-ast-audit-scope.mjs")) {
  const base = process.argv[2];
  if (!base || !/^[0-9a-f]{7,40}$/i.test(base)) {
    console.error("Usage: node scripts/classify-ast-audit-scope.mjs <base-sha>");
    process.exit(2);
  }
  const changed = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRT", `${base}...HEAD`], { encoding: "utf8" })
    .split("\n").filter(Boolean);
  const selected = selectAstAudits(changed);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    for (const name of all) appendFileSync(output, `run_${name}=${selected.includes(name)}\n`);
    appendFileSync(output, `run_any=${selected.length > 0}\n`);
  }
  console.log(`changed_files=${changed.length}`);
  console.log(`selected_ast_audits=${selected.length ? selected.join(",") : "none"}`);
}
