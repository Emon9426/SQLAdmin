# SQLAdmin marketplace icon generator: 128x128 PNG
Add-Type -AssemblyName System.Drawing

$size = 128
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# rounded gradient background
$c1 = [System.Drawing.Color]::FromArgb(255, 14, 99, 156)
$c2 = [System.Drawing.Color]::FromArgb(255, 17, 119, 187)
$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$gradPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 26
$gradPath.AddArc(0, 0, $r, $r, 180, 90)
$gradPath.AddArc(($size - $r), 0, $r, $r, 270, 90)
$gradPath.AddArc(($size - $r), ($size - $r), $r, $r, 0, 90)
$gradPath.AddArc(0, ($size - $r), $r, $r, 90, 90)
$gradPath.CloseFigure()
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @($rect, $c1, $c2, 60.0)
$g.FillPath($brush, $gradPath)

# white database cylinder geometry
$cubeLeft = 30
$cubeRight = 98
$topY = 30
$bodyBottom = 100
$ellH = 20
$midW = $cubeRight - $cubeLeft
$ellMid = $topY + $ellH / 2
$bodyH = $bodyBottom - $topY - $ellH / 2
$botY = $bodyBottom - $ellH / 2

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 5)

$topRect = New-Object System.Drawing.Rectangle -ArgumentList @($cubeLeft, $topY, $midW, $ellH)
$g.FillEllipse($white, $topRect)
$bodyRect = New-Object System.Drawing.Rectangle -ArgumentList @($cubeLeft, $ellMid, $midW, $bodyH)
$g.FillRectangle($white, $bodyRect)
$g.DrawLine($whitePen, $cubeLeft, $ellMid, $cubeLeft, $bodyBottom)
$g.DrawLine($whitePen, $cubeRight, $ellMid, $cubeRight, $bodyBottom)
$botRect = New-Object System.Drawing.Rectangle -ArgumentList @($cubeLeft, $botY, $midW, $ellH)
$g.FillEllipse($white, $botRect)

# blue separator arcs
$bgPen = New-Object System.Drawing.Pen($c1, 4)
$arcRect1 = New-Object System.Drawing.Rectangle -ArgumentList @($cubeLeft, 56, $midW, $ellH)
$g.DrawArc($bgPen, $arcRect1, 0, 180)
$arcRect2 = New-Object System.Drawing.Rectangle -ArgumentList @($cubeLeft, 76, $midW, $ellH)
$g.DrawArc($bgPen, $arcRect2, 0, 180)

# amber SQL bolt
$amberColor = [System.Drawing.Color]::FromArgb(255, 226, 185, 61)
$amber = New-Object System.Drawing.SolidBrush($amberColor)
$bolt = New-Object System.Drawing.Drawing2D.GraphicsPath
$p1 = New-Object System.Drawing.Point(94, 50)
$p2 = New-Object System.Drawing.Point(64, 94)
$p3 = New-Object System.Drawing.Point(80, 94)
$p4 = New-Object System.Drawing.Point(70, 118)
$p5 = New-Object System.Drawing.Point(104, 72)
$p6 = New-Object System.Drawing.Point(86, 72)
$bolt.AddPolygon(@($p1, $p2, $p3, $p4, $p5, $p6))
$g.FillPath($amber, $bolt)
$boltPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 26, 62, 94), 3)
$g.DrawPath($boltPen, $bolt)

$g.Dispose()
$out = Join-Path $PSScriptRoot "icon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "icon saved: $out"
