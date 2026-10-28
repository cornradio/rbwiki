# Deploy RBWiki code to the homeserver and restart the screen session.
# Usage:
#   .\deploy.ps1
#   .\deploy.ps1 -IncludeData
# Default leaves the server's wiki-data (pages, uploads, password) in place.
# -IncludeData replaces that data with this machine's copy.

param(
    [switch]$IncludeData
)

$ErrorActionPreference = 'Stop'

$Remote = '192.168.31.11'
$RemoteDir = '/home/kasusa/rbwiki'
$Root = $PSScriptRoot
$Archive = Join-Path $env:TEMP 'rbwiki-deploy.tgz'
$RemoteScript = Join-Path $env:TEMP 'rbwiki-remote-update.sh'

if (Test-Path $Archive) { Remove-Item $Archive -Force }

$tarArgs = @(
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=deploy.ps1'
)
if (-not $IncludeData) { $tarArgs += '--exclude=wiki-data' }
$tarArgs += @('-czf', $Archive, '-C', $Root, '.')
& tar @tarArgs
if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }

$remoteUpdate = @'
#!/bin/bash
set -euo pipefail
mkdir -p /home/kasusa/rbwiki
tar -xzf /tmp/rbwiki-deploy.tgz -C /home/kasusa/rbwiki
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
cd /home/kasusa/rbwiki
npm ci --omit=dev
if sudo -n /usr/local/sbin/saferun restart rbwiki; then
  :
else
  docker run --rm --privileged --pid host -v /:/host kasusa/lan-clip:latest chroot /host /usr/local/sbin/saferun restart rbwiki
fi
sleep 1
code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3010/rbWiki)
echo "rbWiki $code"
test "$code" = "200"
/usr/local/sbin/saferun status | awk 'BEGIN{p=0} $1=="rbwiki"{p=1} p{print} p && /^[^ ]/ && $1!="rbwiki"{exit}'
'@
$remoteUpdate = $remoteUpdate -replace "`r`n", "`n" -replace "`r", "`n"
[System.IO.File]::WriteAllText($RemoteScript, $remoteUpdate)

# Windows OpenSSH treats "C:\..." as host:path. Upload by filename from the temp folder.
Push-Location $env:TEMP
try {
    scp -o BatchMode=yes (Split-Path $Archive -Leaf) "${Remote}:/tmp/rbwiki-deploy.tgz"
    if ($LASTEXITCODE -ne 0) { throw "upload failed ($LASTEXITCODE)" }
    scp -o BatchMode=yes (Split-Path $RemoteScript -Leaf) "${Remote}:/tmp/rbwiki-remote-update.sh"
    if ($LASTEXITCODE -ne 0) { throw "upload of update script failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}
ssh -o BatchMode=yes $Remote "bash /tmp/rbwiki-remote-update.sh"
if ($LASTEXITCODE -ne 0) { throw "remote update failed ($LASTEXITCODE)" }

Write-Host "Updated $RemoteDir"
Write-Host "Open http://${Remote}:3010/rbWiki"
if (-not $IncludeData) { Write-Host "Server wiki-data was left as it is." }
