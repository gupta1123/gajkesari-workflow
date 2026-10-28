import fs from 'node:fs';
import path from 'node:path';

// The library owns download verification, caching, differential downloads and
// Windows installation. This adapter only connects those events to our UI and
// waits until ongoing Tally work is finished before allowing a restart.
export function createElectronConnectorUpdater({engine, version, directory, onState = () => {},
  prepareForInstall, beforeQuit = async () => {}, resumeAfterFailure = () => {}, logger = console}) {
  let state = {phase: 'idle', currentVersion: version, message: 'Check for connector updates.', progress: null};
  let inFlight = null;
  let prepared = false;
  const receipt = path.join(directory, 'electron-update-pending.json');
  const historyFile = path.join(directory, 'electron-update-history.json');
  const emit = patch => { state = {...state, ...patch}; onState({...state}); return state; };
  const exclusive = action => {
    if (inFlight) return inFlight;
    inFlight = action().finally(() => { inFlight = null; });
    return inFlight;
  };
  const fail = error => {
    const stage = state.phase;
    logger.error(`Connector update failed during ${stage}: ${error?.stack || error}`);
    if (prepared) {
      prepared = false;
      fs.rmSync(receipt, {force: true});
      Promise.resolve().then(resumeAfterFailure).catch(e => logger.error(e));
    }
    return emit({phase: 'error', progress: null, detail: error?.message || String(error),
      message: stage === 'restarting'
        ? 'The update could not be installed. Your current version is unchanged. Please try again.'
        : 'Could not complete the update. Your current version is unchanged. Please try again.'});
  };
  engine.logger = logger;
  engine.autoDownload = false;
  engine.autoInstallOnAppQuit = false;
  engine.allowPrerelease = false;
  engine.allowDowngrade = false;
  engine.disableDifferentialDownload = false;
  engine.disableWebInstaller = true;
  engine.on('checking-for-update', () => emit({phase: 'checking', message: 'Checking for updates…', detail: null, progress: null}));
  engine.on('update-available', info => emit({phase: 'available', latestVersion: info.version,
    message: `Version ${info.version} is available.`, checkedAt: new Date().toISOString(), detail: null, progress: null}));
  engine.on('update-not-available', () => emit({phase: 'current', latestVersion: null,
    message: "You're up to date.", checkedAt: new Date().toISOString(), detail: null, progress: null}));
  engine.on('download-progress', info => emit({phase: 'downloading',
    message: 'Downloading update…', progress: Math.min(100, Math.max(0, Math.floor(info.percent)))}));
  engine.on('update-downloaded', info => emit({phase: 'ready', latestVersion: info.version,
    message: 'Update downloaded and verified. Ready to restart the connector.', progress: 100, detail: null}));
  engine.on('error', fail);
  try {
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (history.version === version && Number.isFinite(Date.parse(history.updatedAt))) {
      state.lastUpdatedAt = history.updatedAt;
      state.lastInstallDurationMs = history.installDurationMs ?? null;
    }
  } catch (error) { if (error.code !== 'ENOENT') logger.error(error); }
  try {
    const pending = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (pending.version === version) {
      const updatedAt = new Date().toISOString();
      const startedAt = Date.parse(pending.requestedAt);
      const installDurationMs = Number.isFinite(startedAt) ? Math.max(0, Date.parse(updatedAt) - startedAt) : null;
      const history = {version, updatedAt, requestedAt:pending.requestedAt ?? null, installDurationMs};
      try { fs.writeFileSync(historyFile, JSON.stringify(history, null, 2)); }
      catch (error) { logger.error(`Could not save connector update history: ${error.message}`); }
      logger.info?.(`Connector update completed: ${JSON.stringify(history)}`);
      emit({phase: 'installed', message: `Updated successfully to ${version}.`, progress: 100,
        lastUpdatedAt:updatedAt, lastInstallDurationMs:installDurationMs});
      fs.rmSync(receipt, {force: true});
    } else {
      emit({phase: 'error', message: 'The previous update did not finish. Please check for updates and try again.', progress: null});
    }
  } catch (error) { if (error.code !== 'ENOENT') logger.error(error); }
  return {
    getState: () => ({...state}),
    check: () => exclusive(async () => {
      if (['ready', 'waiting', 'restarting'].includes(state.phase)) return state;
      try {
        const result = await engine.checkForUpdates();
        if (!result) throw new Error('Updates are only available in an installed connector.');
        return state;
      } catch (error) { return fail(error); }
    }),
    download: () => exclusive(async () => {
      if (state.phase !== 'available') return state;
      emit({phase: 'downloading', message: 'Downloading update…', progress: 0, detail: null});
      try { await engine.downloadUpdate(); return state; }
      catch (error) { return fail(error); }
    }),
    apply: () => exclusive(async () => {
      if (!['ready', 'waiting'].includes(state.phase)) return state;
      try {
        if (!await prepareForInstall()) return emit({phase: 'waiting', message: 'Finish the current Tally work, then click Restart and update.', progress: 100});
        prepared = true;
        fs.mkdirSync(directory, {recursive: true});
        fs.writeFileSync(receipt, JSON.stringify({version: state.latestVersion, requestedAt: new Date().toISOString()}));
        emit({phase: 'restarting', message: 'Installing update. The connector will restart automatically.', progress: 100, detail: null});
        await beforeQuit();
        engine.quitAndInstall(true, true);
        return state;
      } catch (error) { return fail(error); }
    }),
  };
}
