# Generate a multi-size Windows ICO (16/32/48/256, PNG-compressed entries) from a PNG
param(
    [string]$Source = 'D:\222\ElainaChat-redesign\app\web\icons\icon-512.png',
    [string]$OutPath = 'D:\222\webvibe2\ElainaChat\app.ico'
)
Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile($Source)
$entries = @()
foreach ($size in @(256, 48, 32, 16)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $entries += , @($size, $ms.ToArray())
}
$img.Dispose()

$fs = [System.IO.File]::Create($OutPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)                # reserved
$bw.Write([uint16]1)                # type: icon
$bw.Write([uint16]$entries.Count)   # image count
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $size = $e[0]; $bytes = $e[1]
    $dim = if ($size -ge 256) { 0 } else { $size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)   # width/height, 0 means 256
    $bw.Write([byte]0); $bw.Write([byte]0)          # color count, reserved
    $bw.Write([uint16]1); $bw.Write([uint16]32)     # color planes, bits per pixel
    $bw.Write([uint32]$bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $bytes.Length
}
foreach ($e in $entries) { $bw.Write($e[1]) }
$bw.Flush(); $bw.Close()
Write-Host ("OK: {0} ({1} bytes)" -f $OutPath, (Get-Item $OutPath).Length)
