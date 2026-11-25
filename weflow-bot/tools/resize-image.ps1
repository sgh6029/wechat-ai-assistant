param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Max = 1280,
    [int]$Quality = 82
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

try {
    $img = [System.Drawing.Image]::FromFile($In)
} catch {
    Write-Output "FAIL 打不开图片: $($_.Exception.Message)"
    exit 1
}
try {
    $longest = [Math]::Max($img.Width, $img.Height)
    $ratio = if ($longest -gt $Max) { $Max / $longest } else { 1.0 }
    $w = [Math]::Max(1, [int]($img.Width * $ratio))
    $h = [Math]::Max(1, [int]($img.Height * $ratio))

    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $w, $h)
    $g.Dispose()

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    if ($codec) {
        $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), $Quality
        $bmp.Save($Out, $codec, $ep)
    } else {
        $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    }
    $bmp.Dispose()
    $size = (Get-Item -LiteralPath $Out).Length
    Write-Output ("OK {0}x{1} {2}KB" -f $w, $h, [Math]::Round($size / 1024))
} catch {
    Write-Output "FAIL 缩放失败: $($_.Exception.Message)"
    exit 1
} finally {
    $img.Dispose()
}
