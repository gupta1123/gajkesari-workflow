param([Parameter(Mandatory=$true)][string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobPath -Raw | ConvertFrom-Json
$root = [IO.Path]::GetFullPath((Split-Path -Parent $JobPath))
$installRoot = [IO.Path]::GetFullPath('C:\Gajkesari\tally-bridge')
if ([IO.Path]::GetFullPath($job.installDir) -ne $installRoot) { throw 'Unexpected connector installation directory.' }
foreach ($name in @('backup','installer','receipt','ack','ready')) {
  $resolved = [IO.Path]::GetFullPath($job.$name)
  if (-not $resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Update path is outside the update directory.' }
}
$exe = Join-Path $installRoot 'Gajkesari Tally Connector.exe'
$backedUp = $false
$changed = $false
$newProcess = $null
function Save-Receipt($value) {
  $temporary = $job.receipt + '.tmp'
  $value | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $job.receipt -Force
}
try {
  $inputStream = [IO.File]::OpenRead($job.installer)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($inputStream)).Replace('-','').ToLowerInvariant() }
  finally { $inputStream.Dispose(); $hasher.Dispose() }
  if ($actualHash -ne $job.sha256) { throw 'Installer verification failed.' }
  if (Test-Path -LiteralPath $job.backup) { throw 'A previous update backup still needs attention.' }
  Set-Content -LiteralPath $job.ready -Value 'ready'
  Wait-Process -Id $job.parentPid -Timeout 45 -ErrorAction SilentlyContinue
  if (Get-Process -Id $job.parentPid -ErrorAction SilentlyContinue) { throw 'The connector is still running. Installation was not started.' }
  Copy-Item -LiteralPath $installRoot -Destination $job.backup -Recurse -Force
  $backedUp = $true
  $changed = $true
  $setup = Start-Process -FilePath $job.installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/SP-','/NORESTART','/NOCANCEL',('/DIR="' + $installRoot + '"')) -WindowStyle Hidden -PassThru -Wait
  if ($setup.ExitCode -ne 0) { throw ('Installation failed with exit code ' + $setup.ExitCode) }
  $package = Get-Content -LiteralPath (Join-Path $installRoot 'resources\app\package.json') -Raw | ConvertFrom-Json
  if ($package.version -ne $job.version) { throw 'Installed connector version did not match the update.' }
  Save-Receipt @{status='installed';version=$job.version;installedAt=[DateTime]::UtcNow.ToString('o')}
  $newProcess = Start-Process -FilePath $exe -ArgumentList @('--show-updates') -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $job.ack) {
      $ack = $null
      try { $ack = Get-Content -LiteralPath $job.ack -Raw | ConvertFrom-Json } catch {}
      if ($ack.version -eq $job.version) {
        # Both paths were resolved and bounded above before recursive deletion.
        # Antivirus can temporarily lock a backup. Cleanup must not roll back
        # an update whose new UI has already confirmed successful startup.
        try { Remove-Item -LiteralPath $job.backup -Recurse -Force } catch {}
        exit 0
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw 'The updated connector did not confirm a successful restart.'
} catch {
  $failure = $_.Exception.Message
  if ($newProcess) { Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
  $restored = $false
  if ($changed -and $backedUp) {
    try {
      New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
      Get-ChildItem -LiteralPath $job.backup -Force | Copy-Item -Destination $installRoot -Recurse -Force
      $restored = $true
    } catch { $failure += '; recovery: ' + $_.Exception.Message }
  }
  Save-Receipt @{status='failed';version=$job.version;error=$failure;rolledBack=$restored}
  if (-not (Get-Process -Id $job.parentPid -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $exe)) {
    Start-Process -FilePath $exe -ArgumentList @('--show-updates') -WindowStyle Hidden
  }
  exit 1
}
