import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createElectronConnectorUpdater} from './electron-updates.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gajkesari-nsis-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const engine = new EventEmitter();
  const calls = [], logs = [];
  let busy = false;
  engine.checkForUpdates = async () => {
    calls.push('check'); engine.emit('checking-for-update');
    engine.emit('update-available', {version: '0.1.84'}); return {updateInfo: {version: '0.1.84'}};
  };
  engine.downloadUpdate = async () => {
    calls.push('download'); engine.emit('download-progress', {percent: 47});
    engine.emit('update-downloaded', {version: '0.1.84'}); return ['verified.exe'];
  };
  engine.quitAndInstall = (...args) => calls.push(['install', ...args]);
  const updater = createElectronConnectorUpdater({engine, version: '0.1.83', directory,
    prepareForInstall: async () => !busy, beforeQuit: async () => calls.push('close-native-handles'),
    resumeAfterFailure: () => calls.push('resume'), logger: {error: x => logs.push(String(x))}});
  return {engine, updater, calls, directory, logs, busy: value => {busy = value;}};
}

test('library controls downloads and differential updates, and closing the app never installs implicitly', async t => {
  const f = fixture(t);
  assert.equal(f.engine.autoDownload, false); assert.equal(f.engine.autoInstallOnAppQuit, false);
  assert.equal(f.engine.disableDifferentialDownload, false); assert.equal(f.engine.disableWebInstaller, true);
  await f.updater.check(); assert.equal(f.updater.getState().phase, 'available');
  assert.deepEqual(f.calls, ['check']);
});
test('download waits for confirmation, busy Tally blocks restart, then native handles close before silent install', async t => {
  const f = fixture(t); await f.updater.check(); await f.updater.download();
  assert.equal(f.updater.getState().phase, 'ready');
  f.busy(true); await f.updater.apply(); assert.equal(f.updater.getState().phase, 'waiting');
  assert.deepEqual(f.calls, ['check', 'download']);
  f.busy(false); await f.updater.apply();
  assert.deepEqual(f.calls, ['check', 'download', 'close-native-handles', ['install', true, true]]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'electron-update-pending.json'))).version, '0.1.84');
});
test('download and installer failures log their cause and cannot claim success', async t => {
  const f = fixture(t); await f.updater.check();
  f.engine.downloadUpdate = async () => {throw new Error('checksum mismatch');};
  await f.updater.download(); assert.equal(f.updater.getState().phase, 'error');
  await f.updater.apply(); assert.deepEqual(f.calls, ['check']);
  assert.ok(f.logs.some(x => x.includes('checksum mismatch')));
});
test('asynchronous installer launch errors restore the Tally runner and discard success marker', async t => {
  const f = fixture(t); await f.updater.check(); await f.updater.download(); await f.updater.apply();
  f.engine.emit('error', new Error('installer launch failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.updater.getState().phase, 'error'); assert.ok(f.calls.includes('resume'));
  assert.equal(fs.existsSync(path.join(f.directory, 'electron-update-pending.json')), false);
});
test('double clicks share work and do not launch two installations', async t => {
  const f = fixture(t); await Promise.all([f.updater.check(), f.updater.check()]);
  await Promise.all([f.updater.download(), f.updater.download()]);
  await Promise.all([f.updater.apply(), f.updater.apply()]);
  assert.equal(f.calls.filter(x => Array.isArray(x)).length, 1);
});
test('restart reports success only after actually running the target version', t => {
  const f = fixture(t);
  const receipt = path.join(f.directory, 'electron-update-pending.json');
  fs.writeFileSync(receipt, JSON.stringify({version: '0.1.84'}));
  const options = {engine: new EventEmitter(), directory: f.directory, prepareForInstall: async () => true, logger: {error() {}}};
  assert.equal(createElectronConnectorUpdater({...options, version: '0.1.83'}).getState().phase, 'error');
  assert.equal(createElectronConnectorUpdater({...options, engine: new EventEmitter(), version: '0.1.84'}).getState().phase, 'installed');
  assert.equal(fs.existsSync(receipt), false);
});
