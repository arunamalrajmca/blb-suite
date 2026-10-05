[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [string]$ExpectedVersion = '5.2.51.48'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
  Write-Error "ZIP not found: $ZipPath"
  exit 1
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$resolvedZip = (Resolve-Path -LiteralPath $ZipPath).Path
$zip = $null
try {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
  $names = @($zip.Entries | ForEach-Object FullName)
  $required = @(
    'manifest.json','background.js','content.js','reference-core.js',
    'case-sensitive-routing.js','case-sensitive-search-core.js','books.js',
    'book-aliases.js','kjv-corpus-original-case.js','kjv-corpus-case-verse-index.js',
    'kjv-case-sensitive-words.js'
  )
  foreach ($r in $required) {
    if ($names -notcontains $r) { throw "Missing required ZIP entry: $r" }
  }

  $entry = $zip.GetEntry('manifest.json')
  if (-not $entry) { throw 'ZIP manifest.json is missing' }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json }
  finally { $reader.Dispose() }

  if ($manifest.manifest_version -ne 3) { throw 'ZIP manifest is not MV3' }
  if ($manifest.version -ne $ExpectedVersion) { throw "ZIP version $($manifest.version) != expected $ExpectedVersion" }
  if (@($manifest.host_permissions) -ne @('http://*/*','https://*/*')) { throw 'ZIP host_permissions regression' }
  if ($manifest.optional_host_permissions) { throw 'ZIP contains optional_host_permissions regression' }

  Write-Host "PASS: ZIP integrity, required entries, MV3, version $ExpectedVersion, host permissions"
  exit 0
}
catch {
  Write-Error "ZIP GATE FAILED: $($_.Exception.Message)"
  exit 1
}
finally {
  if ($zip) { $zip.Dispose() }
}
