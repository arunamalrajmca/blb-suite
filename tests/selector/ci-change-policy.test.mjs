import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isNonRuntimePath, requiresPackageValidation } from "../../scripts/ci-change-policy.mjs";

test("the shared CI path policy keeps documentation, CI, selector and browser-spec edits non-runtime", () => {
  for (const path of [
    "README.md",
    "docs/ci-routing.md",
    ".github/workflows/browser-e2e-groups.yml",
    "tests/selector/browser-selector-decisions.test.mjs",
    "tests/browser/omnibox-command-routing.spec.js",
    "scripts/ci-routing-registry.mjs",
    "scripts/ci-change-policy.mjs"
  ]) {
    assert.equal(isNonRuntimePath(path), true, path);
  }
});

test("store-only assets and dedicated store verifiers remain non-runtime", () => {
  for (const path of [
    "store-assets/promo-tile.png",
    "assets/store/listing.png",
    "extension/icons/icon-128.png",
    "scripts/verify-store-assets.py",
    "tests/test_verify_store_package.py"
  ]) {
    assert.equal(isNonRuntimePath(path), true, path);
  }
});

test("unknown paths and shared extension code are never classified as non-runtime", () => {
  for (const path of [
    "extension/background.js",
    "extension/content.js",
    "extension/reference-core.js",
    "extension/new-runtime-module.js",
    "scripts/new-ci-helper.mjs",
    "tests/browser/fixtures.js",
    "package-lock.json"
  ]) {
    assert.equal(isNonRuntimePath(path), false, path);
  }
});

test("package validation ownership is centralized alongside runtime classification", () => {
  for (const path of [
    ".github/workflows/browser-e2e-groups.yml",
    "tests/selector/ci-change-policy.test.mjs",
    "scripts/ci-change-policy.mjs",
    "scripts/ci-routing-registry.mjs",
    "package-lock.json",
    "extension/manifest.json"
  ]) {
    assert.equal(requiresPackageValidation(path), true, path);
  }
  assert.equal(requiresPackageValidation("README.md"), false);
});

test("both CI selectors consume the same path-policy module", () => {
  const classifier = readFileSync(new URL("../../scripts/classify-ci-changes.mjs", import.meta.url), "utf8");
  const browserSelector = readFileSync(new URL("../../scripts/select-browser-specs.mjs", import.meta.url), "utf8");
  assert.match(classifier, /from "\.\/ci-change-policy\.mjs"/);
  assert.match(browserSelector, /from "\.\/ci-change-policy\.mjs"/);
});
