# Blue Letter Bible Suite — Formal Automated Regression Suite

Baseline: **5.2.51.43**

This suite is the deterministic regression gate for future BLB Suite builds. It tests an extracted candidate package and can separately verify the ZIP that will be installed.

## Windows — recommended run

With the candidate ZIP extracted into `extension\`:

```powershell
.\Run-BLB-Regression.ps1
```

To verify both the extracted package and the actual ZIP:

```powershell
.\Run-BLB-Regression.ps1 -ExtensionPath .\extension -ZipPath ..\Blue-Letter-Bible-Suite-5.2.51.43-REGRESSION-FIX.zip
```

For a future build:

```powershell
.\Run-BLB-Regression.ps1 -ExtensionPath .\candidate -ZipPath .\candidate.zip -ExpectedVersion 5.2.51.44
```

If PowerShell execution policy blocks the script, run it with `powershell -ExecutionPolicy Bypass -File .\Run-BLB-Regression.ps1`.

## What the automated suite covers

- MV3 manifest and expected package version
- required HTTP/HTTPS host permissions
- web + local HTML/PDF content-script coverage
- manifest-referenced files
- no optional-host-permission replacement regression
- JavaScript syntax across the complete package
- shared Bible-reference core
- production selection extractor, including Roman-numeral books
- five-reference extraction
- direct-reference behavior
- case-sensitive query parsing
- exact-case KJV corpus search
- scrambled-case detection
- web contextual resolver contracts
- PDF downstream use of shared classification/resolution
- protected-PDF context limitation as an explicit expected policy
- `b cs` native-search fallback, including the former BLB-home regression

The current 5.2.51.43 package passes **19/19** deterministic tests.

## Browser/E2E gate

Automated source/package tests cannot prove browser UI behavior. The browser regression matrix remains mandatory after the automated suite passes.

`tests/e2e-matrix.json` contains the 18 original regression gates and focused cases. Manual/browser testing must show PASS for every gate before promotion.

The highest-value live cases are:

1. Criteria repeated invocation reuses the matching tab.
2. Web partial `I Thessalonians 2:13` reconstructs the complete reference.
3. Five-reference paragraph extraction returns all five references.
4. Repeated PDF selection does not create duplicate MultiVerse tabs.
5. `b cs Jesus` opens native BLB search and never BLB home.
6. Right-click / Alt+B / floating Show / double-click remain functionally consistent where the platform exposes equivalent context.

## PDF policy

The suite intentionally does **not** require a partial token selected inside the protected PDF viewer to reconstruct surrounding text. That is the currently accepted PDF limitation. Full-reference PDF selection and all downstream shared resolver behavior remain covered.

## Promotion rule

A build is promotable only when:

- automated suite = PASS
- ZIP verifier = PASS
- browser/E2E matrix = PASS
- manual testing finds no unexplained regression against 5.2.51.43
- the tested package is frozen after validation

## Hard build-failure behavior

`Run-BLB-Regression.ps1` is a hard gate. It exits with code **0 only if every automated assertion and, when supplied, the ZIP verifier pass**. Any failed assertion, missing dependency, missing package file, version mismatch, manifest regression, or ZIP verification failure returns a non-zero exit code.

This makes it suitable for a local build script, CI job, release script, or a manual promotion gate. Do not promote a build when the runner returns anything other than `0`.

Example:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Run-BLB-Regression.ps1 `
  -ExtensionPath .\candidate `
  -ZipPath .\candidate.zip `
  -ExpectedVersion 5.2.51.44
if ($LASTEXITCODE -ne 0) { throw 'BLB regression gate failed; promotion blocked.' }
```
