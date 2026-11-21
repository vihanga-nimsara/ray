<#
  Builds the app icon (assets/icon.png + assets/icon.ico) from a square logo.
  The tray/background logo (assets/tray.png) is separate and never touched here.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\icons-from-logo.ps1
    powershell -ExecutionPolicy Bypass -File scripts\icons-from-logo.ps1 -Source assets\ray-icon.png
#>
param(
  [string]$Source = 'assets\ray-icon.png'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = if ([System.IO.Path]::IsPathRooted($Source)) { $Source } else { Join-Path $root $Source }
if (-not (Test-Path $sourcePath)) { throw "Logo not found: $sourcePath" }

$assets = Join-Path $root 'assets'
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @{}
$src = [System.Drawing.Image]::FromFile($sourcePath)

try {
  foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

      # Fit inside a square, preserving aspect ratio and centering.
      $ratio = [Math]::Min($size / $src.Width, $size / $src.Height)
      $w = [int][Math]::Round($src.Width * $ratio)
      $h = [int][Math]::Round($src.Height * $ratio)
      $x = [int][Math]::Round(($size - $w) / 2)
      $y = [int][Math]::Round(($size - $h) / 2)
      $g.DrawImage($src, $x, $y, $w, $h)

      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $pngs[$size] = $ms.ToArray()
      $ms.Dispose()
    } finally {
      $g.Dispose()
      $bmp.Dispose()
    }
  }
} finally {
  $src.Dispose()
}

# icon.png = 256px master
[System.IO.File]::WriteAllBytes((Join-Path $assets 'icon.png'), $pngs[256])

# icon.ico with PNG-compressed entries (supported on Windows Vista and later).
$count = $sizes.Count
$headerSize = 6 + 16 * $count
$offset = $headerSize
$entries = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($entries)

$bw.Write([uint16]0)      # reserved
$bw.Write([uint16]1)      # type: icon
$bw.Write([uint16]$count) # image count

foreach ($size in $sizes) {
  $data = $pngs[$size]
  $dim = if ($size -ge 256) { 0 } else { $size }
  $bw.Write([byte]$dim)       # width
  $bw.Write([byte]$dim)       # height
  $bw.Write([byte]0)          # color count
  $bw.Write([byte]0)          # reserved
  $bw.Write([uint16]1)        # color planes
  $bw.Write([uint16]32)       # bits per pixel
  $bw.Write([uint32]$data.Length)
  $bw.Write([uint32]$offset)
  $offset += $data.Length
}

foreach ($size in $sizes) { $bw.Write($pngs[$size]) }
$bw.Flush()

[System.IO.File]::WriteAllBytes((Join-Path $assets 'icon.ico'), $entries.ToArray())
$bw.Dispose()
$entries.Dispose()

Write-Output "Source: $sourcePath"
Write-Output "Wrote assets/icon.png (256x256) and assets/icon.ico ($($sizes -join ', '))"
