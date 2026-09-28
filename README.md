# Blue Letter Bible Suite

This repository is the source and regression-test baseline for the Blue Letter Bible Suite Chrome/Brave extension.

## Current production baseline

**5.2.51.43 — APPROVED MASTER / PRODUCTION BASELINE**

Git `main` at the 5.2.51.43 release commit is the source of truth for current development and production packaging.

The former **5.2.51.26** master/rollback package is retained as a historical archive only. It is no longer the active development baseline.

## Regression gate

The repository's GitHub Actions workflow runs the deterministic **5.2.51.43 HARD-GATE** regression suite on pushes and pull requests targeting `main`.

The gate validates the extension source and key reference/search behaviors. It is deterministic/source-level CI; browser-dependent actions such as native permission prompts, native context menus, trusted physical gestures, Alt+B, and local `file://` access remain manual regression checks unless reproducible without weakening test validity.

## Local tests

```text
node regression-suite/tests/run-regression.mjs extension
```

The extension is loaded as an unpacked MV3 extension for local/browser testing.

## Scope

Blue Letter Bible Suite combines practical BLB study tools in one Chrome/Brave extension. See `extension/README.md` and `extension/Tutorial.html` for feature documentation.
