import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

// Exercise the real helper's file replacement and rollback in an isolated
// temporary installation. All process/installer calls are mocked; Tally and
// the actual installed connector are never started or modified.
for(const scenario of ['success','cleanup-failed','installer-failed','wrong-version','restart-failed','hash-failed','outside-root']) {
  test(`background updater handles ${scenario} without an installer window`,{skip:process.platform!=='win32'},t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'gajkesari update test '));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const install=path.join(root,'installation'),directory=path.join(root,'updates');
    fs.mkdirSync(path.join(install,'resources','app'),{recursive:true});fs.mkdirSync(directory);
    fs.writeFileSync(path.join(install,'resources','app','package.json'),JSON.stringify({version:'0.1.80'}));
    fs.writeFileSync(path.join(install,'Gajkesari Tally Connector.exe'),'old connector');
    const installer=path.join(directory,'installer.exe');fs.writeFileSync(installer,'example installer');
    const job={version:'0.1.81',parentPid:999998,installDir:scenario==='outside-root'?root:install,
      installer,sha256:createHash('sha256').update('example installer').digest('hex'),backup:path.join(directory,'backup'),
      receipt:path.join(directory,'result.json'),ack:path.join(directory,'ack.json'),ready:path.join(directory,'ready')};
    if(scenario==='hash-failed')job.sha256='0'.repeat(64);
    const jobPath=path.join(directory,'job.json');fs.writeFileSync(jobPath,JSON.stringify(job));
    const quote=v=>v.replace(/'/g,"''");
    const mocks=`
function Wait-Process { param($Id,$Timeout,$ErrorAction) }
function Get-Process { param($Id,$ErrorAction) return $null }
function Stop-Process { param($Id,[switch]$Force,$ErrorAction) }
function Remove-Item {
  param($LiteralPath,[switch]$Recurse,[switch]$Force)
  if ('${scenario}' -eq 'cleanup-failed') { throw 'Backup is temporarily locked.' }
  Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force
}
function Start-Process {
  param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,[switch]$Wait)
  if ($WindowStyle -ne 'Hidden') { throw 'An update process requested a visible window.' }
  if ($FilePath -eq $job.installer) {
    if ($ArgumentList -notcontains '/VERYSILENT' -or $ArgumentList -notcontains '/NORESTART') { throw 'Unsafe installer arguments.' }
    Set-Content -LiteralPath (Join-Path $installRoot 'Gajkesari Tally Connector.exe') -Value 'new connector'
    $next = if ('${scenario}' -eq 'wrong-version') {'0.1.99'} else {$job.version}
    @{version=$next} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installRoot 'resources\\app\\package.json')
    return @{ExitCode=$(if ('${scenario}' -eq 'installer-failed') {1} else {0})}
  }
  if ('${scenario}' -ne 'restart-failed') { @{version=$job.version} | ConvertTo-Json | Set-Content -LiteralPath $job.ack }
  return @{Id=999997}
}
`;
    let source=fs.readFileSync(new URL('./update-helper.ps1',import.meta.url),'utf8');
    source=source.replace("[IO.Path]::GetFullPath('C:\\Gajkesari\\tally-bridge')",`[IO.Path]::GetFullPath('${quote(install)}')`)
      .replace('$ErrorActionPreference = \'Stop\'',`$ErrorActionPreference = 'Stop'\n${mocks}`)
      .replace('.AddSeconds(90)','.AddSeconds(1)');
    const helper=path.join(directory,'helper.ps1');fs.writeFileSync(helper,source);
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-JobPath',jobPath],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(result.error,undefined);
    if(scenario==='outside-root') {
      assert.notEqual(result.status,0);assert.match(result.stderr,/Unexpected connector installation/);
      assert.equal(fs.readFileSync(path.join(install,'Gajkesari Tally Connector.exe'),'utf8'),'old connector');return;
    }
    const receipt=JSON.parse(fs.readFileSync(job.receipt,'utf8').replace(/^\uFEFF/,''));
    const installed=JSON.parse(fs.readFileSync(path.join(install,'resources','app','package.json'),'utf8').replace(/^\uFEFF/,''));
    if(scenario==='success'||scenario==='cleanup-failed'){
      assert.equal(result.status,0,JSON.stringify({receipt,stderr:result.stderr}));assert.equal(receipt.status,'installed');assert.equal(installed.version,'0.1.81');assert.equal(fs.existsSync(job.backup),scenario==='cleanup-failed');
    }else {
      assert.equal(receipt.status,'failed');assert.equal(installed.version,'0.1.80');
      if(scenario!=='hash-failed')assert.equal(receipt.rolledBack,true,JSON.stringify(receipt));
      assert.equal(fs.readFileSync(path.join(install,'Gajkesari Tally Connector.exe'),'utf8'),'old connector');
    }
  });
}
