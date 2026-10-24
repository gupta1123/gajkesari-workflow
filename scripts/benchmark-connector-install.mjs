import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

// Times the actual full connector archive and the builder's extraction macro.
// No registry, shortcuts, app launch, process termination, or user data access.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(repo, 'installer/tally-bridge/nsis');
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache');
function find(root, name) {
  for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return file;
    if (entry.isDirectory()) {const result = find(file, name); if (result) return result;}
  }
}
const compiler = find(path.join(cache, 'nsis-3.0.4.1'), 'makensis.exe');
const plugin = find(path.join(cache, 'nsis-resources-3.4.1'), 'Nsis7z.dll');
const pluginDir = path.join(path.dirname(path.dirname(plugin)), 'x86-unicode');
const input = path.resolve(process.argv[2] || path.join(repo, 'installer/tally-bridge/output/nsis/0.1.84/GajkesariTallyConnectorSetup-0.1.84.exe'));
const mode = process.argv[3] || 'baseline';
assert.ok(['baseline', 'optimized'].includes(mode));
const root = path.join('C:/tmp/gajkesari-install-benchmark', `${Date.now()}-${mode}`);
fs.mkdirSync(root, {recursive:true});
// electron-builder embeds a standalone 7z package without outer compression.
const bytes = fs.readFileSync(input);
const offset = bytes.indexOf(Buffer.from('377abcaf271c', 'hex'));
assert.ok(offset >= 0);
const size = Number(bytes.readBigUInt64LE(offset + 12) + bytes.readBigUInt64LE(offset + 20)) + 32;
assert.ok(size > 50e6 && offset + size < bytes.length);
fs.writeFileSync(path.join(root, 'app.7z'), bytes.subarray(offset, offset + size));
let extraction = fs.readFileSync(path.join(tools, 'node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh'), 'utf8');
if (mode === 'optimized') extraction = fs.readFileSync(path.join(tools, 'extract-app-fast.nsh'), 'utf8');
// Instrument the unchanged upstream macro in baseline, actual optimized macro
// in the candidate. GetTickCount excludes time spent reading the result log.
extraction = extraction.replace('  Nsis7z::Extract "${FILE}"', '  !insertmacro mark "extract-start"\n  Nsis7z::Extract "${FILE}"\n  !insertmacro mark "extract-end"');
extraction = extraction.replace('    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR', '    !insertmacro mark "copy-start"\n    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR\n    !insertmacro mark "copy-end"');
fs.writeFileSync(path.join(root, 'extract.nsh'), extraction);
fs.writeFileSync(path.join(root, 'benchmark.nsi'), `
Unicode true
RequestExecutionLevel user
SilentInstall silent
CRCCheck force
SetCompress off
OutFile "${path.join(root, 'benchmark.exe')}"
!include LogicLib.nsh
!addplugindir /x86-unicode "${pluginDir}"
!define PRODUCT_NAME "Isolated full connector benchmark"
!define APP_EXECUTABLE_FILENAME "Gajkesari Tally Connector.exe"
!define SYSTYPE_PTR p
!macro mark STAGE
  Push $0
  Push $1
  System::Call 'kernel32::GetTickCount() i.r0'
  FileOpen $1 "${path.join(root, 'timings.txt')}" a
  FileSeek $1 0 END
  FileWrite $1 "\u0024{STAGE}=$0$\\r$\\n"
  FileClose $1
  Pop $1
  Pop $0
!macroend
!macro GajkesariStage TEXT
  !insertmacro mark "\u0024{TEXT}"
!macroend
!include "${path.join(root, 'extract.nsh')}"
Function .onInit
  !insertmacro mark "init"
FunctionEnd
Section
  InitPluginsDir
  SetOutPath "${path.join(root, 'installed connector')}"
  !insertmacro mark "package-start"
  File /oname=$PLUGINSDIR\\app.7z "${path.join(root, 'app.7z')}"
  !insertmacro mark "package-end"
  !insertmacro extractUsing7za "$PLUGINSDIR\\app.7z"
  !insertmacro mark "install-end"
SectionEnd
`);
execFileSync(compiler, ['/V2', path.join(root, 'benchmark.nsi')], {windowsHide:true, stdio:'inherit'});
const start = performance.now();
const child = spawn(path.join(root, 'benchmark.exe'), ['/S'], {windowsHide:true, stdio:'ignore'});
const code = await new Promise(resolve => child.on('exit', resolve));
assert.equal(code, 0, 'Full payload benchmark installer must succeed.');
const wallMs = Math.round(performance.now() - start);
const events = fs.readFileSync(path.join(root, 'timings.txt'), 'utf8').trim().split(/\r?\n/).map(line => {const at = line.lastIndexOf('=');return {stage:line.slice(0, at),tick:Number(line.slice(at + 1))};});
const summary = {mode, root, input, installerBytes:fs.statSync(input).size, archiveBytes:size, wallMs, events};
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
