param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') {throw 'Invalid version'}
$folder=Join-Path $env:APPDATA 'Gajkesari\ReleaseSigning'
$keyFile=Join-Path $folder 'operator-ed25519.dpapi'
$public='installer/tally-bridge/electron-app/operator-release-key.pem'
if (!(Test-Path -LiteralPath $keyFile)) {
  if(Test-Path -LiteralPath $public){throw 'The original signing account is required; refusing to replace its public key.'}
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  $encoded=node -e "const c=require('crypto'),fs=require('fs'),p=c.generateKeyPairSync('ed25519');fs.writeFileSync(process.argv[1],p.publicKey.export({format:'pem',type:'spki'}));process.stdout.write(p.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'))" $public
  if ($LASTEXITCODE){throw 'Key generation failed'}
  ConvertFrom-SecureString (ConvertTo-SecureString $encoded -AsPlainText -Force) | Set-Content -LiteralPath $keyFile
}
$installer="installer/tally-bridge/output/nsis/$Version/GajkesariTallyConnectorSetup-$Version.exe"
if (!(Test-Path -LiteralPath $installer)){Write-Output 'Public key ready for packaging.';return}
$secret=(Get-Content -Raw -LiteralPath $keyFile).Trim() | ConvertTo-SecureString
$cred=New-Object System.Management.Automation.PSCredential('signing-key',$secret)
$cred.GetNetworkCredential().Password | node -e "const fs=require('fs'),c=require('crypto'),p=require('path');const [file,version,pub]=process.argv.slice(1),bytes=fs.readFileSync(file),key=c.createPrivateKey({key:Buffer.from(fs.readFileSync(0,'utf8').trim(),'base64'),format:'der',type:'pkcs8'});const manifest=JSON.stringify({product:'gajkesari-operator-nsis-x64',version,size:bytes.length,sha256:c.createHash('sha256').update(bytes).digest('hex')});const sig=c.sign(null,Buffer.from(manifest),key);if(!c.verify(null,Buffer.from(manifest),fs.readFileSync(pub),sig))throw Error('Signing key mismatch');fs.writeFileSync(p.join(p.dirname(file),'operator-release.json'),JSON.stringify({manifest,signature:sig.toString('base64')}));" $installer $Version $public
if($LASTEXITCODE){throw 'Release signing failed'}
