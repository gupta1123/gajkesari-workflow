import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache');
function find(root, name) {
  for (const item of fs.readdirSync(root, {withFileTypes:true})) {
    const file = path.join(root, item.name);
    if (item.isFile() && item.name.toLowerCase() === name.toLowerCase()) return file;
    if (item.isDirectory()) {const result = find(file, name); if (result) return result;}
  }
}
const compiler = find(path.join(cache, 'nsis-3.0.4.1'), 'makensis.exe');
const plugin = find(path.join(cache, 'nsis-resources-3.4.1'), 'nsis7z.dll');
const plugins = path.join(path.dirname(path.dirname(plugin)), 'x86-unicode');
const seven = find(path.join(cache, '7zip@1.0.0'), '7za.exe');
const root = path.join('C:/tmp/gajkesari-install-files', String(Date.now()));
const payload = path.join(root, 'payload');
fs.mkdirSync(path.join(payload, 'resources/nested'), {recursive:true});
fs.writeFileSync(path.join(payload, 'ConnectorTest.exe'), 'new-executable');
fs.writeFileSync(path.join(payload, 'resources/nested/data.json'), 'new-nested-data');
fs.writeFileSync(path.join(payload, 'resources/app.json'), 'new-app-data');
const archive = path.join(root, 'payload.7z');
execFileSync(seven, ['a', '-t7z', '-mx=1', '-ms=off', archive, '.'], {cwd:payload, windowsHide:true, stdio:'ignore'});
for (const scenario of ['fresh', 'existing-folder', 'locked-file']) {
  const target = path.join(root, scenario);
  fs.mkdirSync(path.join(target, 'resources'), {recursive:true});
  if (scenario === 'existing-folder') {
    fs.writeFileSync(path.join(target, 'resources/retained.txt'), 'keep-me');
    fs.writeFileSync(path.join(target, 'resources/app.json'), 'old-data');
  }
  const script = path.join(root, `${scenario}.nsi`);
  const exe = path.join(root, `${scenario}.exe`);
  fs.writeFileSync(script, `
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${exe}"
!include LogicLib.nsh
!addplugindir /x86-unicode "${plugins}"
!define APP_EXECUTABLE_FILENAME "ConnectorTest.exe"
!macro GajkesariStage TEXT
!macroend
!include "${path.join(repo, 'installer/tally-bridge/nsis/extract-app-fast.nsh')}"
Section
  InitPluginsDir
  SetOutPath "${target}"
  ${scenario === 'locked-file' ? 'FileOpen $7 "$OUTDIR\\ConnectorTest.exe" w\nFileWrite $7 "locked-original"' : ''}
  File /oname=$PLUGINSDIR\\app.7z "${archive}"
  !insertmacro extractUsing7za "$PLUGINSDIR\\app.7z"
  FileOpen $7 "$OUTDIR\\success.txt" w
  FileClose $7
SectionEnd
`);
  execFileSync(compiler, ['/V2', script], {windowsHide:true, stdio:'inherit'});
  const result = spawnSync(exe, ['/S'], {windowsHide:true, timeout:20000});
  if (scenario === 'locked-file') {
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(target, 'success.txt')), false);
    assert.equal(fs.readFileSync(path.join(target, 'ConnectorTest.exe'), 'utf8'), 'locked-original');
  } else {
    assert.equal(result.status, 0);
    for (const file of ['ConnectorTest.exe', 'resources/nested/data.json', 'resources/app.json']) {
      assert.deepEqual(fs.readFileSync(path.join(target, file)), fs.readFileSync(path.join(payload, file)));
    }
    if (scenario === 'existing-folder') assert.equal(fs.readFileSync(path.join(target, 'resources/retained.txt'), 'utf8'), 'keep-me');
  }
  console.log(`PASS ${scenario}`);
}
console.log(`Filesystem integration tests passed: ${root}`);
