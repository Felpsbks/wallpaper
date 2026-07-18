Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile("c:\Users\kille\OneDrive\Documentos\Respositorio\EngineWallpaper\ui\logo-app-max.png")
$bmp = new-object System.Drawing.Bitmap(256, 256)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, 0, 0, 256, 256)
$g.Dispose()
$img.Dispose()
$bmp.Save("c:\Users\kille\OneDrive\Documentos\Respositorio\EngineWallpaper\ui\logo-tray.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
