<#
  Pi Sat Track - Windows network / process helper (Windows PowerShell 5.1+).
  Called by install-win.bat / uninstall-win.bat (as Administrator):
    win-network.ps1 -Action Install     port 80 proxy + firewall rules, print URLs
    win-network.ps1 -Action Uninstall   stop the server, remove proxy + rules
    win-network.ps1 -Action Stop        stop this app's server only
    win-network.ps1 -Action Urls        print the URLs

  Port 80: the app listens on TCP 3000 (all interfaces). A Windows portproxy
  (IP Helper service) forwards 0.0.0.0:80 -> 127.0.0.1:3000, so the app needs
  no admin rights or code change. If something else (IIS, Skype, ...) already
  owns port 80, the proxy is skipped and :3000 is used.
  Firewall: inbound TCP 80 and 3000, all profiles (home networks are often
  "Public"), limited to the local subnet. Rules are recreated by name.
#>
param(
  [ValidateSet('Install', 'Uninstall', 'Stop', 'Urls')]
  [string]$Action = 'Urls',
  [string]$AppDir = $PSScriptRoot,
  [int]$AppPort = 3000,
  [switch]$NoPort80
)
$ErrorActionPreference = 'Continue'
$RuleNames = @('Pi Sat Track (TCP 80)', 'Pi Sat Track (TCP 3000)')
$LegacyRules = @('Pi Sat Track HTTP 80')

function Get-ProxyEntries {
  # netsh lines: "<listen addr>  <listen port>  <connect addr>  <connect port>"
  $out = @()
  foreach ($line in (netsh interface portproxy show v4tov4 2>$null)) {
    $p = ($line.Trim() -split '\s+')
    if ($p.Count -eq 4 -and $p[1] -match '^\d+$' -and $p[3] -match '^\d+$') {
      $out += [pscustomobject]@{ ListenAddress = $p[0]; ListenPort = [int]$p[1]; ConnectAddress = $p[2]; ConnectPort = [int]$p[3] }
    }
  }
  return $out
}

function Remove-OurProxy {
  # Every 80 -> :AppPort entry (also per-IP ones older installers added)
  foreach ($e in (Get-ProxyEntries | Where-Object { $_.ListenPort -eq 80 -and $_.ConnectPort -eq $AppPort })) {
    netsh interface portproxy delete v4tov4 listenaddress=$($e.ListenAddress) listenport=80 | Out-Null
    Write-Host "  removed port proxy $($e.ListenAddress):80 -> $($e.ConnectAddress):$AppPort"
  }
}

function Remove-OurRules {
  foreach ($n in ($RuleNames + $LegacyRules)) {
    netsh advfirewall firewall delete rule name="$n" 2>$null | Out-Null
  }
}

function Get-Port80Owner {
  # $null = free; otherwise the owning process name(s)
  $c = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue
  if (-not $c) { return $null }
  $names = @()
  foreach ($procId in ($c.OwningProcess | Select-Object -Unique)) {
    $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($procId -eq 4) { $names += 'System (http.sys: IIS / web services)' }
    elseif ($pr) { $names += $pr.ProcessName } else { $names += "PID $procId" }
  }
  return ($names -join ', ')
}

function Get-LanIPv4 {
  $ips = @()
  foreach ($cfg in (Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' })) {
    foreach ($a in $cfg.IPv4Address) { $ips += $a.IPAddress }
  }
  return ($ips | Select-Object -Unique)
}

function Show-Urls([bool]$Port80) {
  $suffix = if ($Port80) { '' } else { ":$AppPort" }
  Write-Host ''
  Write-Host '  Open:'
  Write-Host "    http://localhost$suffix/"
  foreach ($ip in (Get-LanIPv4)) { Write-Host "    http://$ip$suffix/   (other devices on your network)" }
  if ($Port80) { Write-Host "    (port $AppPort works too: http://localhost:$AppPort/)" }
}

function Stop-AppServer {
  # Only this app's server: node.exe listening on :AppPort, or running <AppDir>\server.js
  $ids = @()
  foreach ($c in (Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue)) { $ids += $c.OwningProcess }
  $esc = [regex]::Escape((Join-Path $AppDir 'server.js'))
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
    if ($p.CommandLine -match $esc) { $ids += $p.ProcessId }
  }
  $stopped = 0
  foreach ($procId in ($ids | Select-Object -Unique)) {
    $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($pr -and $pr.ProcessName -eq 'node') {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      Write-Host "  stopped Pi Sat Track server (node PID $procId)"
      $stopped++
    }
  }
  if (-not $stopped) { Write-Host '  server not running' }
}

function Show-FirewallState {
  $prof = Get-NetFirewallProfile -ErrorAction SilentlyContinue
  if ($prof) {
    $on = ($prof | Where-Object { $_.Enabled } | ForEach-Object { $_.Name }) -join ', '
    if ($on) { Write-Host "  Windows Firewall on for: $on" } else { Write-Host '  Windows Firewall is off' }
  }
  foreach ($n in (Get-NetConnectionProfile -ErrorAction SilentlyContinue)) {
    Write-Host "  network '$($n.Name)' is $($n.NetworkCategory)"
  }
  # A "Cancel" on the first node.exe firewall prompt leaves BLOCK rules that beat any allow rule (port 3000 only; the port 80 proxy is not node)
  $blocks = Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue |
    Where-Object { ($_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program -match 'node\.exe$' }
  foreach ($b in $blocks) {
    Write-Host "  WARNING: firewall rule '$($b.DisplayName)' blocks node.exe ($($b.Profile)); http://<this PC>:$AppPort/ from other devices stays blocked until you disable it (wf.msc)." -ForegroundColor Yellow
  }
}

switch ($Action) {
  'Install' {
    Write-Host 'Network setup'
    Remove-OurRules
    $port80 = $false
    if ($NoPort80) {
      Remove-OurProxy
      Write-Host '  port 80 proxy skipped (--no-port80)'
    } else {
      Set-Service iphlpsvc -StartupType Automatic -ErrorAction SilentlyContinue
      Start-Service iphlpsvc -ErrorAction SilentlyContinue
      # Our own proxy holds :80 on a re-run: remove it first, then see who is left
      Remove-OurProxy
      Start-Sleep -Milliseconds 500
      $owner = Get-Port80Owner
      if ($owner) {
        Write-Host "  port 80 is used by ${owner}: no proxy, use port $AppPort" -ForegroundColor Yellow
      } else {
        netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=127.0.0.1 connectport=$AppPort | Out-Null
        if ($LASTEXITCODE -eq 0) {
          $port80 = $true
          Write-Host "  port proxy 0.0.0.0:80 -> 127.0.0.1:$AppPort"
        } else { Write-Host '  WARNING: port proxy add failed; use port 3000' -ForegroundColor Yellow }
      }
    }
    if ($port80) {
      netsh advfirewall firewall add rule name="$($RuleNames[0])" dir=in action=allow protocol=TCP localport=80 profile=any remoteip=localsubnet | Out-Null
      Write-Host "  firewall: allow TCP 80 from the local network"
    }
    netsh advfirewall firewall add rule name="$($RuleNames[1])" dir=in action=allow protocol=TCP localport=$AppPort profile=any remoteip=localsubnet | Out-Null
    Write-Host "  firewall: allow TCP $AppPort from the local network"
    Show-FirewallState
    Show-Urls $port80
  }
  'Uninstall' {
    Write-Host 'Stopping server'
    Stop-AppServer
    Write-Host 'Removing port 80 proxy and firewall rules'
    Remove-OurProxy
    Remove-OurRules
    Write-Host '  done'
  }
  'Stop' { Stop-AppServer }
  'Urls' {
    $has80 = [bool](Get-ProxyEntries | Where-Object { $_.ListenPort -eq 80 -and $_.ConnectPort -eq $AppPort })
    Show-Urls $has80
  }
}
exit 0
