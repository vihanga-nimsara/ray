# Lists Start-menu entries exposed through the shell AppsFolder.
# Emits a compact JSON array: [{ name, appId, logo }]
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-LogoPath($package) {
  $install = $package.InstallLocation
  if (-not $install) { return $null }
  $manifest = Join-Path $install 'AppxManifest.xml'
  if (-not (Test-Path -LiteralPath $manifest)) { return $null }

  try {
    [xml]$xml = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8
  } catch { return $null }

  $logo = $null
  $visual = $xml.GetElementsByTagName('VisualElements') | Select-Object -First 1
  if ($visual) { $logo = $visual.GetAttribute('Square44x44Logo') }
  if (-not $logo -and $xml.Package.Properties) { $logo = $xml.Package.Properties.Logo }
  if (-not $logo) { return $null }

  $logoDir = Join-Path $install (Split-Path $logo -Parent)
  $base = [System.IO.Path]::GetFileNameWithoutExtension($logo)
  if (-not (Test-Path -LiteralPath $logoDir)) { return $null }

  $candidates = Get-ChildItem -LiteralPath $logoDir -Filter "$base*.png" |
    Where-Object { $_.Name -notmatch 'contrast-' }
  if (-not $candidates) { return $null }

  $ranked = $candidates | Sort-Object {
    if ($_.Name -match 'targetsize-64_altform-lightunplated') { 0 }
    elseif ($_.Name -match 'targetsize-48_altform-lightunplated') { 1 }
    elseif ($_.Name -match 'targetsize-64') { 2 }
    elseif ($_.Name -match 'targetsize-48') { 3 }
    elseif ($_.Name -match 'scale-200') { 4 }
    elseif ($_.Name -match 'scale-150') { 5 }
    elseif ($_.Name -match 'scale-100') { 6 }
    else { 7 }
  }
  return $ranked[0].FullName
}

$packages = @{}
foreach ($pkg in Get-AppxPackage) {
  $family = $pkg.PackageFamilyName
  if (-not $family) { continue }
  $logo = Get-LogoPath $pkg
  if ($logo) { $packages[$family] = $logo }
}

$result = @()
foreach ($app in Get-StartApps) {
  $appId = [string]$app.AppID
  if ($appId -notmatch '!') { continue }
  $family = ($appId -split '!')[0]
  $result += [pscustomobject]@{
    name  = [string]$app.Name
    appId = $appId
    logo  = [string]$packages[$family]
  }
}

$result | ConvertTo-Json -Compress
