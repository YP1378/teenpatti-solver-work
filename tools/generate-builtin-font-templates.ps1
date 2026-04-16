param(
    [string]$OutputRoot = $(Join-Path (Split-Path -Parent $PSScriptRoot) 'screen-recognition\builtin-font-templates')
)

Add-Type -AssemblyName System.Drawing

function Ensure-Directory([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function New-TemplateImage(
    [string]$text,
    [string]$path,
    [string]$fontName,
    [float]$fontSize,
    [int]$width,
    [int]$height,
    [System.Drawing.Color]$color,
    [float]$offsetX = 0,
    [float]$offsetY = 0
) {
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $font = New-Object System.Drawing.Font($fontName, $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush($color)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $layoutRect = New-Object System.Drawing.RectangleF($offsetX, $offsetY, $width, $height)
    $graphics.DrawString($text, $font, $brush, $layoutRect, $format)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $format.Dispose()
    $brush.Dispose()
    $font.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

$ranksDir = Join-Path $OutputRoot 'ranks'
$suitsDir = Join-Path $OutputRoot 'suits'
Ensure-Directory $OutputRoot
Ensure-Directory $ranksDir
Ensure-Directory $suitsDir

$rankTextMap = [ordered]@{
    'A' = 'A'
    'K' = 'K'
    'Q' = 'Q'
    'J' = 'J'
    'T' = '10'
    '9' = '9'
    '8' = '8'
    '7' = '7'
    '6' = '6'
    '5' = '5'
    '4' = '4'
    '3' = '3'
    '2' = '2'
}

foreach ($entry in $rankTextMap.GetEnumerator()) {
    $path = Join-Path $ranksDir ($entry.Key + '.png')
    New-TemplateImage -text $entry.Value -path $path -fontName 'Times New Roman' -fontSize 28 -width 28 -height 36 -color ([System.Drawing.Color]::Black) -offsetX -1 -offsetY -2
}

$suitTextMap = [ordered]@{
    's' = ([char]0x2660)
    'h' = ([char]0x2665)
    'd' = ([char]0x2666)
    'c' = ([char]0x2663)
}

foreach ($entry in $suitTextMap.GetEnumerator()) {
    $path = Join-Path $suitsDir ($entry.Key + '.png')
    New-TemplateImage -text $entry.Value -path $path -fontName 'Segoe UI Symbol' -fontSize 22 -width 24 -height 24 -color ([System.Drawing.Color]::Black) -offsetX 0 -offsetY -1
}

Write-Host "Built-in font templates generated at: $OutputRoot"
