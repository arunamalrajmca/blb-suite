#!/usr/bin/env node
/**
 * Select repository-wide AST audits from the actual source areas they inspect.
 * Unknown analyzer/dependency changes fail safe to the full audit set.
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
const repoWideJs = ["symbol", "repository", "owner", "runtime", "unified", "computed", "metaprogramming"];
const nonExtensionJs = ["symbol", "repository", "owner", "cross_module", "runtime", "unified", "computed", "metaprogramming"];
const repoWideModules = ["owner", "runtime", "unified", "computed", "metaprogramming"];
const nonExtensionModules = ["owner", "cross_module", "runtime", "unified", "computed", "metaprogramming"];
const metadataRoots = ["owner", "cross_module", "unified"];
const extensionMetadata = ["repository", "owner", "unified", "executable_source"];

function add(selected, names) { for (const name of names) selected.add(name); }

export function selectAstAudits(changedPaths, { full = false } = {}) {
  const selected = new Set();
  if (full) return all;
  for (const path of changedPaths) {
    if (path === "package.json" || path === "package-lock.json" ||
        path === "scripts/classify-ast-audit-scope.mjs" ||
        path === "scripts/ast-audit-input-fingerprint.mjs" ||
        path === "scripts/ast-shared-utils.js") return all;

    let matched = false;
    for (const [name, paths] of Object.entries(auditDefinitions)) {
      if (paths.includes(path)) { selected.add(name); matched = true; }
    }

    if (matched) {
      // Analyzer/test JavaScript is itself included in the repository-wide
      // source scans. Re-run every scanner that consumes that extension, in
      // addition to the directly owned audit.
      if (/\.js$/i.test(path)) add(selected, nonExtensionJs);
      else if (/\.(?:cjs|mjs)$/i.test(path)) add(selected, nonExtensionModules);
      if (path === auditDefinitions.owner[0] || path === auditDefinitions.owner[1]) add(selected, ["cross_module", "unified"]);
      if (path === auditDefinitions.runtime[0] || path === auditDefinitions.runtime[1]) selected.add("unified");
      if (path === auditDefinitions.unified[0] || path === auditDefinitions.unified[1]) selected.add("cross_module");
      continue;
    }

    if (/^scripts\/ast-.*(?:\.js|\.mjs)$/.test(path)) return all;

    if (path.startsWith("extension/")) {
      if (/\.js$/i.test(path)) {
        add(selected, repoWideJs);
        selected.add("executable_source");
      } else if (/\.(?:cjs|mjs)$/i.test(path)) {
        add(selected, repoWideModules);
        selected.add("executable_source");
      } else if (/\.(?:html|json)$/i.test(path) || path === "extension/manifest.json") {
        add(selected, extensionMetadata);
      }
      // Cross-module Node graph intentionally excludes extension/ sources.
      if (!/\.(?:js|cjs|mjs|html|json)$/i.test(path)) matched = true;
    } else if (/\.js$/i.test(path)) {
      add(selected, nonExtensionJs);
    } else if (/\.(?:cjs|mjs)$/i.test(path)) {
      add(selected, nonExtensionModules);
    } else if (/^tests\/|^regression-suite\//.test(path) && /\.(?:html|json)$/i.test(path)) {
      add(selected, ["repository", "owner", "cross_module", "unified"]);
    } else if (/^\.github\/workflows\/|^\.github\/actions\//.test(path) &&
               /(?:\.ya?ml|\.sh|\.js|\.mjs)$/.test(path)) {
      add(selected, metadataRoots);
    } else if (/\.ya?ml$/i.test(path) && (path.startsWith("tests/") || path.startsWith("regression-suite/"))) {
      add(selected, ["owner", "cross_module", "unified"]);
    } else if (path === "manifest.json" || /(^|\/)manifest[^/]*\.json$/i.test(path)) {
      add(selected, ["repository", "owner", "cross_module", "unified"]);
    } else if (!matched && /^scripts\/ast-.*(?:\.js|\.mjs)$/.test(path)) {
      return all;
    }
  }
  return all.filter(name => selected.has(name));
}

if (process.argv[1]?.endsWith("classify-ast-audit-scope.mjs")) {
  const base = process.argv[2];
  if (!base || !/^[0-9a-f]{7,40}$/i.test(base)) {
    console.error("Usage: node scripts/classify-ast-audit-scope.mjs <base-sha>");
    process.exit(2);
  }
  const changed = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRT", base + "...HEAD"], { encoding: "utf8" })
    .split("\n").filter(Boolean);
  const selected = selectAstAudits(changed);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    for (const name of all) appendFileSync(output, "run_" + name + "=" + selected.includes(name) + "\n");
    appendFileSync(output, "run_any=" + (selected.length > 0) + "\n");
  }
  console.log("changed_files=" + changed.length);
  console.log("selected_ast_audits=" + (selected.length ? selected.join(",") : "none"));
}
