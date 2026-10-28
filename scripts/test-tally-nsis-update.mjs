import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {copyUpdaterDependencies} from './connector-updater-dependencies.mjs';
import {runNsisBuilder} from './run-nsis-builder.mjs';

// A real NSIS install, differential download, silent install and restart under
// a unique Windows app identity. It never loads the Tally bridge or its config.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(repo, 'installer/tally-bridge');
const tools = path.join(installer, 'nsis');
const source = path.join(installer, 'payload-clean');
const run = Date.now().toString();
// NSIS tooling has older path handling; keep build paths short while the
// installation and user-data paths still exercise spaces in Windows paths.
const root = path.join('C:/tmp/gajkesari-nsis-tests', run);
const output = path.join(root, 'release');
const installation = path.join(root, 'installed connector');
const userData = path.join(root, 'user data');
const resultFile = path.join(root, 'completed.json');
const requests = [];
fs.mkdirSync(output, {recursive: true});
const legacyRoot = path.join(root, 'legacy connector');
fs.mkdirSync(legacyRoot, {recursive: true});
const includeFile = path.join(root, 'installer-ux.nsh');
fs.copyFileSync(path.join(tools, 'installer-ux.nsh'), includeFile);
const server = http.createServer((request, response) => {
  const name = path.basename(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  const file = path.join(output, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
  const size = fs.statSync(file).size;
  let start = 0, end = size - 1;
  if (request.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
    if (!match) { response.writeHead(416).end(); return; }
    start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
    response.statusCode = 206;
    response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Length', end - start + 1);
  requests.push({name, bytes: end - start + 1, range: request.headers.range || null});
  if (request.method === 'HEAD') response.end(); else fs.createReadStream(file, {start, end}).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const feed = `http://127.0.0.1:${server.address().port}/`;
const appId = `com.gajkesari.updater-test-${run}`;
let oldProcess;
let legacyProcess;
try {
  for (const version of ['0.0.1', '0.0.2']) {
    const payload = path.join(root, `payload-${version}`);
    const app = path.join(payload, 'resources/app');
    fs.mkdirSync(app, {recursive: true});
    for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
      if (entry.name === 'locales' || entry.isFile() && /\.(exe|dll|pak|bin|dat|json)$/.test(entry.name) && entry.name !== 'package.json') {
        fs.cpSync(path.join(source, entry.name), path.join(payload, entry.name), {recursive: true});
      }
    }
    fs.renameSync(path.join(payload, 'Gajkesari Tally Connector.exe'), path.join(payload, 'Gajkesari Updater Test.exe'));
    copyUpdaterDependencies(tools, path.join(app, 'node_modules'));
    fs.copyFileSync(path.join(installer, 'electron-app/electron-updates.mjs'), path.join(app, 'electron-updates.mjs'));
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({name: `gajkesari-updater-test-${run}`, productName: 'Gajkesari Updater Test', description: 'Isolated connector update test', version, main: 'main.cjs', author: 'Gajkesari'}));
    fs.writeFileSync(path.join(payload, 'resources/app-update.yml'), `provider: generic\nurl: ${feed}\nuseMultipleRangeRequest: false\nupdaterCacheDirName: gajkesari-updater-test-${run}-updater\n`);
    fs.writeFileSync(path.join(app, 'main.cjs'), `
const {app} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu');
app.setName('Gajkesari Updater Test'); app.setPath('userData', ${JSON.stringify(userData)});
app.whenReady().then(async () => {
  const {autoUpdater: engine} = require('electron-updater');
  const {createElectronConnectorUpdater} = await import('./electron-updates.mjs');
  const version = app.getVersion();
  const log = (...items) => fs.appendFileSync(path.join(root, 'update.log'), items.map(String).join(' ')+'\\n');
  const updater = createElectronConnectorUpdater({engine, version, directory: path.join(app.getPath('userData'), 'updates'),
    prepareForInstall: async () => true, logger: {info:log, warn:log, error:log, debug:log},
    onState: state => {log(JSON.stringify(state)); if(state.phase === 'error') fs.writeFileSync(path.join(root, 'error.json'), JSON.stringify(state));}});
  if (version === '0.0.2') {
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({version, phase:updater.getState().phase, executable:process.execPath}));
    setTimeout(() => app.quit(), 500); return;
  }
  await updater.check(); await updater.download(); await updater.apply();
}).catch(error => {fs.writeFileSync(path.join(root, 'error.json'), JSON.stringify({error:error.stack}));app.exit(1);});
`);
    const config = {appId, productName: 'Gajkesari Updater Test', electronVersion: '31.7.7',
      directories: {app, output}, extraMetadata: {version}, npmRebuild: false, asar: false,
      win: {target: ['nsis'], executableName: 'Gajkesari Updater Test', signAndEditExecutable: false},
      nsis: {oneClick: false, perMachine: false, allowElevation: false, runAfterFinish: true, include: includeFile,
        createDesktopShortcut: false, createStartMenuShortcut: false, deleteAppDataOnUninstall: false,
        differentialPackage: true, artifactName: 'UpdaterTest-${version}.${ext}'},
      publish: [{provider: 'generic', url: feed}],
    };
    const configPath = path.join(root, `config-${version}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    await runNsisBuilder(path.join(tools, 'node_modules/electron-builder/out/cli/cli.js'), [
      '--projectDir', tools, '--prepackaged', payload, '--config', configPath, '--win', 'nsis', '--x64', '--publish', 'never'],
    repo);
  }
  const legacyExe = path.join(legacyRoot, 'Gajkesari Updater Test.exe');
  const legacyCode = path.join(root, 'LegacyConnector.cs');
  fs.writeFileSync(legacyCode, 'class LegacyConnector { static void Main() { System.Threading.Thread.Sleep(300000); } }');
  const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', `/out:${legacyExe}`, legacyCode], {windowsHide: true});
  legacyProcess = spawn(legacyExe, [], {windowsHide: true, stdio: 'ignore'});
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(legacyProcess.exitCode, null, 'Legacy test connector must be running before installation.');
  execFileSync(path.join(output, 'UpdaterTest-0.0.1.exe'), ['/S', `/D=${installation}`], {windowsHide: true, timeout: 120000});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.notEqual(legacyProcess.exitCode, null, 'Installer did not close the old-location test connector.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installation, 'resources/app/package.json'))).version, '0.0.1');
  console.log('Installed isolated test version 0.0.1. Starting actual update.');
  oldProcess = spawn(path.join(installation, 'Gajkesari Updater Test.exe'), [], {windowsHide: true, stdio: 'ignore'});
  const deadline = Date.now() + 180000;
  while (!fs.existsSync(resultFile) && !fs.existsSync(path.join(root, 'error.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  if (fs.existsSync(path.join(root, 'error.json'))) throw new Error(fs.readFileSync(path.join(root, 'error.json'), 'utf8'));
  assert.ok(fs.existsSync(resultFile), 'Updated application did not restart. Inspect ' + path.join(root, 'update.log'));
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.version, '0.0.2'); assert.equal(result.phase, 'installed');
  assert.equal(path.resolve(result.executable), path.join(installation, 'Gajkesari Updater Test.exe'));
  const bytes = requests.filter(item => item.name === 'UpdaterTest-0.0.2.exe').reduce((sum, item) => sum + item.bytes, 0);
  const fullBytes = fs.statSync(path.join(output, 'UpdaterTest-0.0.2.exe')).size;
  const ranges = requests.filter(item => item.name === 'UpdaterTest-0.0.2.exe' && item.range).length;
  assert.ok(ranges > 0 && bytes < fullBytes * 0.8, 'Expected a differential download, not a full installer download.');
  const summary = {...result, legacyConnectorClosed: true, bytesDownloaded: bytes, fullInstallerBytes: fullBytes, rangeRequests: ranges, savedPercent: Number(((1 - bytes / fullBytes) * 100).toFixed(2)), root};
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (oldProcess && oldProcess.exitCode === null) oldProcess.kill();
  if (legacyProcess && legacyProcess.exitCode === null) legacyProcess.kill();
}
