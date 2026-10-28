import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createConnectorUpdater,compareVersions,validateManifest,RELEASE_PREFIX,UPDATE_REPOSITORY} from './updates.mjs';
import {prepareConnectorRelease} from '../../../scripts/prepare-connector-release.mjs';

const bytes=Buffer.from('verified example installer for updater tests');
const url=`https://github.com/${UPDATE_REPOSITORY}/releases/download/${RELEASE_PREFIX}0.1.81/GajkesariTallyConnectorSetup-0.1.81.exe`;
const manifest={schemaVersion:1,version:'0.1.81',platform:'win32-x64',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url};
const release={tag_name:RELEASE_PREFIX+'0.1.81',assets:[{name:'connector-update.json',browser_download_url:url.replace(/[^/]+$/,'connector-update.json')},{name:'GajkesariTallyConnectorSetup-0.1.81.exe',browser_download_url:url,size:bytes.length}]};
function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gajkesari-update-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const events=[],calls=[],installed=[];let busy=false;
  const fetcher=async(input)=>{calls.push(input);if(options.fail)throw Error('offline');
    if(input.includes('api.github.com'))return Response.json(options.releases||[release]);
    if(input.endsWith('connector-update.json'))return Response.json(options.manifest||manifest);
    return new Response(options.bytes||bytes);
  };
  const updater=createConnectorUpdater({version:'0.1.80',directory,fetch:fetcher,onState:s=>events.push(s),prepareForInstall:async()=>!busy,
    install:async candidate=>{assert.equal(fs.readFileSync(candidate.installer).toString(),bytes.toString());installed.push(candidate);}});
  return {updater,events,calls,installed,directory,setBusy:value=>{busy=value;}};
}
test('versions compare numerically and only published stable connector releases are considered',async t=>{
  assert.equal(compareVersions('0.1.100','0.1.99'),1);
  const f=fixture(t,{releases:[{...release,prerelease:true},{...release,draft:true},{tag_name:'unrelated-v999'}]});
  assert.equal((await f.updater.check()).phase,'current');assert.equal(f.calls.length,1);
});
test('a real check discovers an update without downloading or installing it',async t=>{
  const f=fixture(t);assert.equal((await f.updater.check()).phase,'available');
  assert.equal(f.calls.length,2);assert.equal(f.installed.length,0);
});
test('download reports progress, verifies content and waits for explicit application',async t=>{
  const f=fixture(t);await f.updater.check();await f.updater.download();
  assert.equal(f.updater.getState().phase,'ready');assert.ok(f.events.some(e=>e.phase==='downloading'&&e.progress===100));
  assert.equal(f.installed.length,0);await f.updater.apply();assert.equal(f.installed.length,1);
});
test('an active Tally operation blocks application without discarding the verified download',async t=>{
  const f=fixture(t);await f.updater.check();await f.updater.download();f.setBusy(true);
  assert.equal((await f.updater.apply()).phase,'waiting');assert.equal(f.installed.length,0);
  f.setBusy(false);await f.updater.apply();assert.equal(f.installed.length,1);
});
test('corrupt and interrupted downloads never reach the installer and partial files are removed',async t=>{
  for(const data of [bytes.subarray(0,3),Buffer.from('X'.repeat(bytes.length)),Buffer.concat([bytes,bytes])]){
    const f=fixture(t,{bytes:data});await f.updater.check();assert.equal((await f.updater.download()).phase,'error');
    await f.updater.apply();assert.equal(f.installed.length,0);assert.deepEqual(fs.readdirSync(f.directory),[]);
  }
});
test('unavailable update service is an error, never an up-to-date claim',async t=>{
  const f=fixture(t,{fail:true});assert.equal((await f.updater.check()).phase,'error');
  assert.doesNotMatch(f.updater.getState().message,/up to date/i);
});
test('incomplete publication, incompatible platform, external URLs and wrong versions fail closed',()=>{
  for(const patch of [{version:'0.1.79'},{platform:'linux-x64'},{sha256:'invalid'},{size:0},{url:'https://example.com/update.exe'},
    {url:url.replace('0.1.81.exe','0.1.82.exe')}])assert.throws(()=>validateManifest({...manifest,...patch},release,'0.1.80'));
  assert.throws(()=>validateManifest(manifest,{...release,assets:[]},'0.1.80'));
});
test('double clicks share one operation and never start two downloads or installers',async t=>{
  const f=fixture(t);await Promise.all([f.updater.check(),f.updater.check()]);
  assert.equal(f.calls.length,2);await Promise.all([f.updater.download(),f.updater.download()]);
  assert.equal(f.calls.length,3);await Promise.all([f.updater.apply(),f.updater.apply()]);assert.equal(f.installed.length,1);
});
test('success is shown only for the running version; rollback has an honest error state',t=>{
  const f=fixture(t);assert.equal(f.updater.restoreResult({status:'installed',version:'0.1.81'}).phase,'idle');
  assert.equal(f.updater.restoreResult({status:'installed',version:'0.1.80'}).phase,'installed');
  assert.match(f.updater.restoreResult({status:'failed',rolledBack:true}).message,/previous version has been restored/);
});
test('release packaging computes the actual installer hash and produces a matching versioned manifest',t=>{
  const f=fixture(t);const input=path.join(f.directory,'installer.exe');fs.writeFileSync(input,bytes);
  const result=prepareConnectorRelease({installer:input,version:'0.1.81',outputDir:path.join(f.directory,'release')});
  assert.equal(result.sha256,manifest.sha256);assert.equal(result.url,manifest.url);
  assert.deepEqual(validateManifest(result,release,'0.1.80'),{version:manifest.version,url,sha256:manifest.sha256,size:bytes.length});
});
