#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { auditDefinitions } from "./classify-ast-audit-scope.mjs";

const JS = /\.(?:js|cjs|mjs)$/i;
const JSON = /\.json$/i;
const HTML = /\.html?$/i;
const YAML = /\.ya?ml$/i;
const EXCLUDED = /^(?:node_modules|coverage|test-results|playwright-report|dist)\//;

export function auditInputPaths(name, trackedPaths) {
  if (!Object.hasOwn(auditDefinitions, name)) throw new Error("Unknown AST audit: " + name);
  const selected = new Set(auditDefinitions[name]);
  const inScope = trackedPaths.filter(file => {
    if (EXCLUDED.test(file)) return false;
    switch (name) {
      case "symbol": return JS.test(file);
      case "repository": return JS.test(file) || HTML.test(file) || JSON.test(file);
      case "owner":
      case "unified": return JS.test(file) || JSON.test(file) || YAML.test(file);
      case "cross_module": return !file.startsWith("extension/") && (JS.test(file) || JSON.test(file) || YAML.test(file));
      case "runtime":
      case "computed":
      case "metaprogramming": return JS.test(file);
      case "executable_source": return file.startsWith("extension/");
      default: return false;
    }
  });
  for (const file of ["package.json", "package-lock.json"]) {
    if (trackedPaths.includes(file)) selected.add(file);
  }
  for (const file of inScope) selected.add(file);
  return [...selected].sort();
}

export function createAuditInputFingerprint(entries) {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function fingerprintAuditInputs(name, root = process.cwd()) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const files = auditInputPaths(name, tracked);
  const entries = files.map(file => ({
    path: file,
    content: fs.readFileSync(path.join(root, file))
  }));
  return { fingerprint: createAuditInputFingerprint(entries), files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: node scripts/ast-audit-input-fingerprint.mjs <audit-name>");
    process.exit(2);
  }
  try {
    const result = fingerprintAuditInputs(name);
    console.log("fingerprint=" + result.fingerprint);
    console.log("input_files=" + result.files.length);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
