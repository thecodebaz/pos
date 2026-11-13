Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot "..\public\icons"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$colors = @{
  background = "#18181b"
  accent = "#059669"
  foreground = "#ffffff"
}

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  $bg = [System.Drawing.ColorTranslator]::FromHtml($colors.background)
  $accent = [System.Drawing.ColorTranslator]::FromHtml($colors.accent)
  $fg = [System.Drawing.ColorTranslator]::FromHtml($colors.foreground)

  $graphics.Clear($bg)

  $margin = [int]($size * 0.12)
  $side = $size - ($margin * 2)
  $accentBrush = New-Object System.Drawing.SolidBrush $accent
  $graphics.FillEllipse($accentBrush, $margin, $margin, $side, $side)

  $fontSize = [int]($size * 0.24)
  $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fgBrush = New-Object System.Drawing.SolidBrush $fg
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
  $graphics.DrawString("POS", $font, $fgBrush, $rect, $format)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  $format.Dispose()
  $font.Dispose()
  $fgBrush.Dispose()
  $accentBrush.Dispose()
  $graphics.Dispose()
  $bmp.Dispose()
}

New-Icon 192 (Join-Path $dir "icon-192.png")
New-Icon 512 (Join-Path $dir "icon-512.png")
New-Icon 180 (Join-Path $dir "apple-touch-icon.png")
New-Icon 32 (Join-Path $dir "favicon-32.png")

Write-Output "Ícones gerados em public/icons"
