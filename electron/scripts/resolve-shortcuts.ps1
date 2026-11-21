# Resolves Start-menu shortcuts to their targets so Ray can pull real icons.
# Emits: [{ path, target, icon }]
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$roots = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
)

$links = @()
foreach ($root in $roots) {
  if (Test-Path -LiteralPath $root) {
    $links += Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue
  }
}

$shell = New-Object -ComObject WScript.Shell
$result = @()
foreach ($link in $links) {
  try {
    $shortcut = $shell.CreateShortcut($link.FullName)
    $result += [pscustomobject]@{
      path   = $link.FullName
      target = [Environment]::ExpandEnvironmentVariables([string]$shortcut.TargetPath)
      icon   = [Environment]::ExpandEnvironmentVariables([string]$shortcut.IconLocation)
    }
  } catch { }
}

$result | ConvertTo-Json -Compress
