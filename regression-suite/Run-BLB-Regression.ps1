[CmdletBinding()]
param(
  [string]$ExtensionPath = "$PSScriptRoot\extension",
  [string]$ZipPath = '',
  [string]$ExpectedVersion = '5.2.51.48'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message, [int]$Code = 1) {
  Write-Error $Message
  exit $Code
}

try {
  if (-not (Test-Path -LiteralPath $ExtensionPath -PathType Container)) {
    Fail "Extension path not found: $ExtensionPath"
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Fail 'Node.js was not found on PATH. Automated regression gate cannot run.' 2 }

  $testScript = Join-Path $PSScriptRoot 'tests\run-regression.mjs'
  if (-not (Test-Path -LiteralPath $testScript -PathType Leaf)) {
    Fail "Regression test runner missing: $testScript"
  }

  $env:BLB_EXPECTED_VERSION = $ExpectedVersion

  Write-Host "=== BLB Suite AUTOMATED REGRESSION GATE ===" -ForegroundColor Cyan
  Write-Host "Expected version: $ExpectedVersion"
  Write-Host "Extension path:   $ExtensionPath"

  & $node.Source $testScript $ExtensionPath
  $nodeExit = $LASTEXITCODE
  if ($nodeExit -ne 0) {
    Write-Error "AUTOMATED REGRESSION GATE FAILED (test runner exit code $nodeExit)."
    exit $nodeExit
  }

  if ($ZipPath) {
    if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
      Fail "ZIP path not found: $ZipPath"
    }

    $verifyScript = Join-Path $PSScriptRoot 'Verify-BLB-Zip.ps1'
    if (-not (Test-Path -LiteralPath $verifyScript -PathType Leaf)) {
      Fail "ZIP verifier missing: $verifyScript"
    }

    Write-Host "=== BLB Suite ZIP GATE ===" -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifyScript -ZipPath $ZipPath -ExpectedVersion $ExpectedVersion
    $zipExit = $LASTEXITCODE
    if ($zipExit -ne 0) {
      Write-Error "ZIP GATE FAILED (verifier exit code $zipExit)."
      exit $zipExit
    }
  }

  Write-Host "" 
  Write-Host "BLB automated regression gate: PASS" -ForegroundColor Green
  Write-Host "Exit code: 0"
  exit 0
}
catch {
  Write-Error "BLB automated regression gate aborted: $($_.Exception.Message)"
  exit 1
}
