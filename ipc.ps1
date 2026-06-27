param(
  [Parameter(Mandatory=$true)][string]$Command,
  [string]$ParamsJson = '{}',
  [int]$TimeoutSec = 30,
  [switch]$NoWait
)
# Raw file-IPC client for the s&box Codex Bridge addon.
# Writes req_<id>.json (UTF-8 no BOM) to %TEMP%\sbox-bridge-ipc, polls res_<id>.json.
$dir = Join-Path $env:TEMP 'sbox-bridge-ipc'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$id = 'cc' + [guid]::NewGuid().ToString('N').Substring(0,10)
$paramsObj = if ([string]::IsNullOrWhiteSpace($ParamsJson)) { @{} } else { $ParamsJson | ConvertFrom-Json }
$req = [ordered]@{ id = $id; command = $Command; params = $paramsObj }
$json = $req | ConvertTo-Json -Depth 25 -Compress
$reqPath = Join-Path $dir "req_$id.json"
$resPath = Join-Path $dir "res_$id.json"
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($reqPath, $json, $enc)
if ($NoWait) { Write-Output "SENT $Command (id=$id, no-wait)"; return }
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$res = $null
while ((Get-Date) -lt $deadline) {
  if (Test-Path $resPath) {
    Start-Sleep -Milliseconds 60
    try { $res = [System.IO.File]::ReadAllText($resPath) } catch { Start-Sleep -Milliseconds 120; continue }
    break
  }
  Start-Sleep -Milliseconds 150
}
if ($null -eq $res) { Write-Output "TIMEOUT after ${TimeoutSec}s (no res for $id)"; return }
Write-Output $res
try { Remove-Item $reqPath -ErrorAction SilentlyContinue } catch {}
try { Remove-Item $resPath -ErrorAction SilentlyContinue } catch {}
