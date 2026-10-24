import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {copyUpdaterDependencies} from './connector-updater-dependencies.mjs';
import {runNsisBuilder} from './run-nsis-builder.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(root, 'installer/tally-bridge');
const tools = path.join(installer, 'nsis');
const payload = path.join(installer, 'payload-clean');
const app = path.join(payload, 'resources/app');
const versionIndex = process.argv.indexOf('--version');
const version = versionIndex < 0 ? '0.1.86' : process.argv[versionIndex + 1];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Provide a numeric connector version.');
if (!process.argv.includes('--reuse-payload')) {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-tally-connector-installer.mjs'), '--payload-only'], {cwd: root, stdio: 'inherit'});
} else {
  if (!fs.existsSync(path.join(app, 'package.json'))) throw new Error('No prepared connector payload to reuse.');
  console.log('Reusing the prepared runtime; refreshing wrapper and bridge sources.');
  for (const entry of fs.readdirSync(path.join(installer, 'electron-app'), {withFileTypes:true})) {
    if (entry.isFile() && /\.(mjs|html|css|ps1)$/.test(entry.name)) fs.copyFileSync(path.join(installer, 'electron-app', entry.name), path.join(app, entry.name));
  }
  fs.cpSync(path.join(root, 'apps/tally-bridge/src'), path.join(app, 'src'), {recursive:true});
  // Match the normal payload builder's standalone module replacements.
  fs.copyFileSync(path.join(root, 'packages/shared/src/lib/bank-bill-reference.mjs'), path.join(app, 'src/local-matching/bill-reference.mjs'));
  for (const name of fs.readdirSync(path.join(app, 'src/document-parsing/backend-logic'))) {
    fs.copyFileSync(path.join(root, 'apps/api/worker', name), path.join(app, 'src/document-parsing/backend-logic', name));
  }
}

// Preserve the existing, verified Electron runtime and native parsing modules.
// Only add the updater dependency tree to the standalone payload.
const updaterPackage = path.join(app, 'node_modules/electron-updater/package.json');
const updaterVersion = JSON.parse(fs.readFileSync(path.join(tools, 'package.json'))).dependencies['electron-updater'];
if (!process.argv.includes('--reuse-payload') || !fs.existsSync(updaterPackage)
  || JSON.parse(fs.readFileSync(updaterPackage)).version !== updaterVersion) {
  copyUpdaterDependencies(tools, path.join(app, 'node_modules'));
}
// Only Chromium's English UI translations are used by this English app.
// These .pak files do not contain PDF fonts or parsing data.
let localeBytesRemoved = 0;
for (const entry of fs.readdirSync(path.join(payload, 'locales'))) {
  if (entry.endsWith('.pak') && !['en-US.pak', 'en-GB.pak'].includes(entry)) {
    const file = path.join(payload, 'locales', entry);
    localeBytesRemoved += fs.statSync(file).size;
    fs.unlinkSync(file);
  }
}
console.log(`Removed ${localeBytesRemoved.toLocaleString()} bytes of unused Chromium UI translations.`);
const metadata = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
Object.assign(metadata, {version, productName: 'Gajkesari Tally Connector', description: 'Gajkesari Tally Connector', author: 'Gajkesari', connectorUpdater: 'electron-updater'});
metadata.dependencies['electron-updater'] = updaterVersion;
delete metadata.devDependencies;
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(metadata, null, 2));
const runtimeMetadata = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({...runtimeMetadata, version}, null, 2));
const bridge = path.join(app, 'src/bridge.mjs');
fs.writeFileSync(bridge, fs.readFileSync(bridge, 'utf8').replace(/const BRIDGE_VERSION = "[^"]+"/, `const BRIDGE_VERSION = "${version}"`));
const output = path.join(installer, 'output/nsis', version);
fs.mkdirSync(output, {recursive: true});
const electronVersion = execFileSync(path.join(payload, 'Gajkesari Tally Connector.exe'), ['-p', 'process.versions.electron'],
  {encoding: 'utf8', windowsHide: true, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}}).trim();
fs.writeFileSync(path.join(payload, 'resources/app-update.yml'),
  `provider: github\nowner: gupta1123\nrepo: gajkesari-workflow\nupdaterCacheDirName: ${metadata.name}-updater\n`);
const config = {
  appId: 'com.gajkesari.tally-connector', productName: 'Gajkesari Tally Connector',
  electronVersion,
  directories: {app, output},
  extraMetadata: {version},
  npmRebuild: false, asar: false,
  protocols: [{name: 'Gajkesari Tally Protocol', schemes: ['gajkesari-tally']}],
  win: {target: ['nsis'], executableName: 'Gajkesari Tally Connector', signAndEditExecutable: false,
    icon: path.join(tools, 'assets/gajkesari.ico')},
  nsis: {oneClick: false, perMachine: false, allowElevation: false, runAfterFinish: true,
    include: path.join(tools, 'installer-ux.nsh'),
    installerSidebar: path.join(tools, 'assets/installer-sidebar.bmp'),
    uninstallerSidebar: path.join(tools, 'assets/installer-sidebar.bmp'),
    installerIcon: path.join(tools, 'assets/gajkesari.ico'), uninstallerIcon: path.join(tools, 'assets/gajkesari.ico'),
    deleteAppDataOnUninstall: false, differentialPackage: true,
    artifactName: 'GajkesariTallyConnectorSetup-${version}.${ext}'},
  publish: [{provider: 'github', owner: 'gupta1123', repo: 'gajkesari-workflow', releaseType: 'release', vPrefixedTagName: false}],
};
const configFile = path.join(output, 'nsis-build-config.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
await runNsisBuilder(path.join(tools, 'node_modules/electron-builder/out/cli/cli.js'), [
  '--projectDir', tools, '--prepackaged', payload, '--config', configFile, '--win', 'nsis', '--x64', '--publish', 'never'],
root);
console.log(`NSIS trial installer and blockmap created in ${output}`);
