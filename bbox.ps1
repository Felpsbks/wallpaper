Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile("c:\Users\kille\Downloads\logoaplicaitvo.png")
$bmp = new-object System.Drawing.Bitmap($img)
$minX = $bmp.Width; $minY = $bmp.Height; $maxX = 0; $maxY = 0;

for ($y = 0; $y -lt $bmp.Height; $y += 5) {
    for ($x = 0; $x -lt $bmp.Width; $x += 5) {
        $c = $bmp.GetPixel($x, $y)
        if ($c.A -gt 10 -and ($c.R -lt 240 -or $c.G -lt 240 -or $c.B -lt 240)) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}
Write-Output "Bounding Box: X=$minX Y=$minY W=$($maxX - $minX) H=$($maxY - $minY)"
$bmp.Dispose()
$img.Dispose()
