# Pi Sat Track (Windows): open the browser after the server starts.
# Waits 10 s (always), then up to 20 s more until http://localhost:3000/ answers,
# then opens it in the default browser. Started hidden by start-sat-tracker.bat.
param([string]$Url = "http://localhost:3000/", [int]$MinWait = 10, [int]$MaxExtra = 20)
Start-Sleep -Seconds $MinWait
$deadline = (Get-Date).AddSeconds($MaxExtra)
while ((Get-Date) -lt $deadline) {
  try { Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 }
}
Start-Process $Url
