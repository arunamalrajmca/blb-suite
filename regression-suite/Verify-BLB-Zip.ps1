[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [string]$ExpectedVersion = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
  throw "ZIP not found: $ZipPath"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$resolvedZip = (Resolve-Path -LiteralPath $ZipPath).Path
$zip = $null

function Assert-ZipEntry {
  param([string]$Path, [string[]]$Entries)
  $normalized = $Path -replace '\\', '/'
  if ([string]::IsNullOrWhiteSpace($normalized) -or $Entries -notcontains $normalized) {
    throw "Manifest references missing ZIP entry: $Path"
  }
}

try {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
  $names = @($zip.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })

  if ($names -contains 'extension/manifest.json') {
    throw 'ZIP entries are nested under extension/; extension files must be at the ZIP root'
  }

  $required = @(
    'manifest.json',
    'background.js',
    'content.js',
    'reference-core.js',
    'case-sensitive-routing.js',
    'case-sensitive-search-core.js',
    'books.js',
    'book-aliases.js',
    'kjv-corpus-original-case.js',
    'kjv-corpus-case-verse-index.js',
    'kjv-case-sensitive-words.js',
    'kjv-corpus-word-index.js',
    'kjv-corpus-phrase-index.js',
    'kjv-corpus-verses.js',
    'kjv-corpus-word-verse-index.js',
    'popup.html',
    'popup.js',
    'Tutorial.html',
    'Tutorial.js',
    'Tutorial.pdf',
    'THIRD-PARTY-NOTICES.txt',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png'
  )
  foreach ($path in $required) {
    if ($names -notcontains $path) { throw "Missing required ZIP entry: $path" }
  }

  $entry = $zip.GetEntry('manifest.json')
  if (-not $entry) { throw 'ZIP manifest.json is missing' }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json }
  finally { $reader.Dispose() }

  if ($manifest.manifest_version -ne 3) { throw 'ZIP manifest is not MV3' }
  if ([string]::IsNullOrWhiteSpace([string]$manifest.version)) { throw 'ZIP manifest version is missing' }
  if ($ExpectedVersion -and $manifest.version -ne $ExpectedVersion) {
    throw "ZIP version $($manifest.version) != expected $ExpectedVersion"
  }

  # Check every file path declared as a local manifest entry point.
  if ($manifest.options_page) { Assert-ZipEntry -Path $manifest.options_page -Entries $names }
  if ($manifest.background.service_worker) { Assert-ZipEntry -Path $manifest.background.service_worker -Entries $names }
  if ($manifest.action.default_popup) { Assert-ZipEntry -Path $manifest.action.default_popup -Entries $names }
  foreach ($iconSize in $manifest.icons.PSObject.Properties) {
    Assert-ZipEntry -Path ([string]$iconSize.Value) -Entries $names
  }
  foreach ($iconSize in $manifest.action.default_icon.PSObject.Properties) {
    Assert-ZipEntry -Path ([string]$iconSize.Value) -Entries $names
  }
  foreach ($contentScript in @($manifest.content_scripts)) {
    foreach ($path in @($contentScript.js)) {
      Assert-ZipEntry -Path ([string]$path) -Entries $names
    }
    foreach ($path in @($contentScript.css)) {
      Assert-ZipEntry -Path ([string]$path) -Entries $names
    }
  }
  foreach ($resourceGroup in @($manifest.web_accessible_resources)) {
    foreach ($path in @($resourceGroup.resources)) {
      # Chrome permits glob patterns in web_accessible_resources.
      if ($path -notmatch '[*?]') { Assert-ZipEntry -Path ([string]$path) -Entries $names }
    }
  }

  # Match the current least-privilege manifest model: BLB is granted directly,
  # while broad website access is optional and requested only when needed.
  $hostPermissions = @($manifest.host_permissions)
  if ($hostPermissions -notcontains 'https://www.blueletterbible.org/*') {
    throw 'ZIP host_permissions must include https://www.blueletterbible.org/*'
  }
  if (($hostPermissions -contains 'http://*/*') -or ($hostPermissions -contains 'https://*/*')) {
    throw 'Broad website access must remain optional, not in required host_permissions'
  }

  $optionalHostPermissions = @($manifest.optional_host_permissions)
  foreach ($permission in @('http://*/*', 'https://*/*')) {
    if ($optionalHostPermissions -notcontains $permission) {
      throw "ZIP optional_host_permissions must include $permission"
    }
  }

  Write-Host "PASS: ZIP integrity, manifest entry points, tutorial assets, icons, MV3, version $($manifest.version), and host-permission model"
  exit 0
}
catch {
  Write-Error "ZIP GATE FAILED: $($_.Exception.Message)"
  exit 1
}
finally {
  if ($zip) { $zip.Dispose() }
}
