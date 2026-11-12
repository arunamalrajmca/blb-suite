/**
 * Shared CI path policy used by both the HARD-GATE classifier and browser
 * suite selector. Unknown paths deliberately remain runtime-affecting.
 */

export function isNonRuntimePath(path) {
  return /^(?:docs\/|README(?:\.|$)|LICENSE(?:\.|$)|CHANGELOG(?:\.|$)|CONTRIBUTING(?:\.|$)|\.github\/(?:workflows\/|ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\/)|tests\/selector\/|scripts\/(?:classify-ci-changes|select-browser-specs|select-reference-matrix|ci-routing-registry|ci-change-policy)\.mjs|scripts\/reference-e2e-matrix\.json$|scripts\/test-ci-routing-selector\.js)/i.test(path)
    || /^scripts\/test-(?:cross-feature-contracts|extraction-safety-contracts|module-loading-contracts|multiverse-reference-helpers|omnibox-boolean-operators|omnibox-gibberish-filter|omnibox-search-normalization|reference-core-characterization|selection-marker-stripping|selection-text-normalization|single-word-selection-normalization|study-session-export|study-session-normalization)\.js$/i.test(path)
    || path === "scripts/package-release.sh"
    || path === "regression-suite/Verify-BLB-Zip.ps1"
    || path === "scripts/validate-build.js"
    || path === "scripts/run-validation-tests.js"
    || path === "scripts/validation-test-manifest.json"
    || path === "regression-suite/Run-BLB-Regression.ps1"
    || path === "regression-suite/README.md"
    || /^regression-suite\/tests\//.test(path)
    || path === "scripts/test-popup-cross-browser-rendering.js"
    || /^tests\/browser\/[^/]+\.spec\.js$/i.test(path)
    || /^(?:scripts\/(?:verify-store-assets|verify-store-branding|verify-store-package|verify-store-submission-assets)\.py|tests\/test_verify_store_(?:package|submission_assets)\.py)$/i.test(path)
    || /^(store-assets\/|assets\/store\/|extension\/(icons|store-assets)\/)/i.test(path);
}

export function requiresPackageValidation(path) {
  return path.startsWith(".github/workflows/")
    || path.startsWith("tests/selector/")
    || path.startsWith("regression-suite/")
    || path === "scripts/classify-ci-changes.mjs"
    || path === "scripts/select-browser-specs.mjs"
    || path === "scripts/select-reference-matrix.mjs"
    || path === "scripts/ci-routing-registry.mjs"
    || path === "scripts/ci-change-policy.mjs"
    || path === "scripts/run-validation-tests.js"
    || path === "scripts/validation-test-manifest.json"
    || path === "scripts/reference-e2e-matrix.json"
    || path === "scripts/test-ci-routing-selector.js"
    || /^scripts\/test-(?:cross-feature-contracts|extraction-safety-contracts|module-loading-contracts|multiverse-reference-helpers|omnibox-boolean-operators|omnibox-gibberish-filter|omnibox-search-normalization|reference-core-characterization|selection-marker-stripping|selection-text-normalization|single-word-selection-normalization|study-session-export|study-session-normalization)\.js$/i.test(path)
    || path === "scripts/test-popup-cross-browser-rendering.js"
    || path === "scripts/package-release.sh"
    || path === "scripts/validate-build.js"
    || path === "package.json"
    || path === "package-lock.json"
    || path === "extension/manifest.json"
    || path === "playwright.config.js"
    || path === "playwright.config.ts";
}
