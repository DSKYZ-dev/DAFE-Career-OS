# Build your branding assets from your logo PNG
#
# Drop your logo as:  branding/logo.png   (a square PNG works best)
# Then run this script from the project root in PowerShell:
#
#     powershell -ExecutionPolicy Bypass -File branding\build-assets.ps1
#
# It generates:
#   branding/logo.ico            (multi-size .ico for the .exe launcher)
#   branding/favicon.ico         (small .ico for docs/site)
#   branding/logo-256.png        (large PNG for README / social cards)
#
# Requirements: Windows 10/11 with PowerShell 5.1+ (no extra installs).
# Uses the built-in .NET System.Drawing to resize + encode ICO.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$src  = Join-Path $root "logo.png"

if (-not (Test-Path $src)) {
    Write-Error "Missing $src — drop your square logo PNG there first."
    exit 1
}

Add-Type -AssemblyName System.Drawing

function Make-Ico {
    param([string]$pngPath, [int[]]$sizes, [string]$outPath)
    $images = @()
    foreach ($s in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($s, $s)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $srcImg = [System.Drawing.Image]::FromFile($pngPath)
        $g.DrawImage($srcImg, 0, 0, $s, $s)
        $g.Dispose(); $srcImg.Dispose()
        $images += $bmp
    }
    $ico = [System.Drawing.Icon]::FromHandle($images[0].GetHicon())
    $fs = [System.IO.File]::Create($outPath)
    $ico.Save($fs)
    $fs.Close(); $ico.Dispose()
    $images | ForEach-Object { $_.Dispose() }
    Write-Host "  wrote $outPath"
}

# Multi-size ICO (Windows picks the best fit)
Make-Ico -pngPath $src -sizes @(16,32,48,64,128,256) -outPath (Join-Path $root "logo.ico")
Make-Ico -pngPath $src -sizes @(16,32,48)           -outPath (Join-Path $root "favicon.ico")

# Large PNG export for README / social cards
$big = New-Object System.Drawing.Bitmap(512, 512)
$g  = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)
$srcImg = [System.Drawing.Image]::FromFile($src)
$g.DrawImage($srcImg, 0, 0, 512, 512)
$g.Dispose(); $srcImg.Dispose()
$big.Save((Join-Path $root "logo-256.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()
Write-Host "  wrote branding/logo-256.png"

Write-Host ""
Write-Host "Done. You can now build the .exe launcher:"
Write-Host "  iexpress /N /Q build-launcher.sed"
