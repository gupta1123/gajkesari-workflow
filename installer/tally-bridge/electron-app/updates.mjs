import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const UPDATE_REPOSITORY = 'gupta1123/gajkesari-workflow';
export const RELEASE_PREFIX = 'gajkesari-tally-connector-v';
const API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
export function compareVersions(a,b) {
  const parse=v=>{if(!/^\d+\.\d+\.\d+$/.test(String(v)))throw Error('Invalid connector version.');return v.split('.').map(Number);};
  const x=parse(a),y=parse(b);return Math.sign(x[0]-y[0]||x[1]-y[1]||x[2]-y[2]);
}
export function trustedReleaseUrl(value,version) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.search||url.hash||
    !url.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/${RELEASE_PREFIX}${version}/`))throw Error('The update download address is not trusted.');
  return url.toString();
}
export function validateManifest(value,release,currentVersion) {
  const version=String(value?.version||'');
  if(value?.schemaVersion!==1||release.tag_name!==RELEASE_PREFIX+version||compareVersions(version,currentVersion)<=0||value.platform!=='win32-x64'||
    !/^[a-f0-9]{64}$/i.test(value.sha256||'')||!Number.isSafeInteger(value.size)||value.size<=0||value.size>MAX_INSTALLER_BYTES)
    throw Error('The update information is incomplete or incompatible.');
  const expected=`GajkesariTallyConnectorSetup-${version}.exe`;
  const url=trustedReleaseUrl(value.url,version);
  if(decodeURIComponent(new URL(url).pathname.split('/').at(-1))!==expected)throw Error('The installer name does not match this update.');
  const asset=release.assets?.find(a=>a.name===expected&&a.browser_download_url===url);
  if(!asset||asset.size!==value.size)throw Error('The published installer does not match the update information.');
  return {version,url,sha256:value.sha256.toLowerCase(),size:value.size};
}

export function createConnectorUpdater({version,directory,fetch:fetcher=globalThis.fetch,onState=()=>{},prepareForInstall,install}) {
  let state={phase:'idle',currentVersion:version,message:'Check for connector updates.',progress:null};
  let candidate=null,downloadPath=null,inFlight=null;
  const emit=patch=>{state={...state,...patch};onState({...state});return state;};
  const headers={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':`GajkesariConnector/${version}`};
  const json=async(url)=>{const r=await fetcher(url,{headers,cache:'no-store',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error(`Update service returned ${r.status}.`);return r.json();};
  const exclusive=fn=>{if(inFlight)return inFlight;inFlight=fn().finally(()=>{inFlight=null;});return inFlight;};
  function fail(error){return emit({phase:'error',message:'Could not update the connector. Your current version is unchanged. Please try again.',detail:error.message,progress:null});}
  return {
    getState:()=>({...state}),
    check:()=>exclusive(async()=>{
      if(['ready','restarting'].includes(state.phase))return state;
      emit({phase:'checking',message:'Checking for updates…',progress:null,detail:null});
      try {
        const releases=await json(API);
        if(!Array.isArray(releases))throw Error('Invalid update service response.');
        const newer=releases.filter(r=>!r.draft&&!r.prerelease&&r.tag_name?.startsWith(RELEASE_PREFIX)&&/^\d+\.\d+\.\d+$/.test(r.tag_name.slice(RELEASE_PREFIX.length)))
          .filter(r=>compareVersions(r.tag_name.slice(RELEASE_PREFIX.length),version)>0)
          .sort((a,b)=>compareVersions(b.tag_name.slice(RELEASE_PREFIX.length),a.tag_name.slice(RELEASE_PREFIX.length)));
        if(!newer.length){candidate=null;return emit({phase:'current',latestVersion:null,message:"You're up to date.",checkedAt:new Date().toISOString()});}
        const release=newer[0],next=release.tag_name.slice(RELEASE_PREFIX.length);
        const manifest=release.assets?.find(a=>a.name==='connector-update.json');
        if(!manifest)throw Error('The latest update has not finished publishing. Please check again shortly.');
        candidate=validateManifest(await json(trustedReleaseUrl(manifest.browser_download_url,next)),release,version);
        return emit({phase:'available',latestVersion:candidate.version,message:`Version ${candidate.version} is available.`,checkedAt:new Date().toISOString()});
      }catch(error){return fail(error);}
    }),
    download:()=>exclusive(async()=>{
      if(!candidate)return state;
      if(downloadPath&&state.phase==='ready')return state;
      fs.mkdirSync(directory,{recursive:true});
      const partial=path.join(directory,`connector-${candidate.version}.exe.part`);
      const complete=partial.slice(0,-5);
      emit({phase:'downloading',message:'Downloading update…',progress:0,detail:null});
      let fd;
      try {
        const response=await fetcher(candidate.url,{headers,signal:AbortSignal.timeout(15*60*1000)});
        if(!response.ok||!response.body)throw Error('The update could not be downloaded.');
        const digest=createHash('sha256');let received=0;fd=fs.openSync(partial,'w');
        for await(const chunk of response.body){const bytes=Buffer.from(chunk);received+=bytes.length;if(received>candidate.size)throw Error('The update is larger than expected.');
          let offset=0;while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset);
          digest.update(bytes);const progress=Math.floor(received*100/candidate.size);if(progress!==state.progress)emit({progress});}
        fs.closeSync(fd);fd=undefined;
        emit({phase:'verifying',message:'Verifying update…',progress:100});
        if(received!==candidate.size||digest.digest('hex')!==candidate.sha256)throw Error('The update verification failed. Nothing was installed.');
        fs.renameSync(partial,complete);downloadPath=complete;
        return emit({phase:'ready',message:'Update downloaded. Ready to restart the connector.',progress:100});
      }catch(error){if(fd!==undefined)fs.closeSync(fd);fs.rmSync(partial,{force:true});downloadPath=null;return fail(error);}
    }),
    apply:()=>exclusive(async()=>{
      if(!candidate||!downloadPath||!['ready','waiting','error'].includes(state.phase))return state;
      try {
        if(!await prepareForInstall()){return emit({phase:'waiting',message:'Finish the current Tally work, then click Restart and update.',progress:100});}
        emit({phase:'restarting',message:'Preparing update. The connector will restart automatically.',progress:100});
        await install({...candidate,installer:downloadPath});
        return state;
      }catch(error){return fail(error);}
    }),
    restoreResult(receipt){
      if(receipt?.status==='installed'&&receipt.version===version)return emit({phase:'installed',message:`Updated successfully to ${version}.`,progress:100});
      if(receipt?.status==='failed')return emit({phase:'error',message:receipt.rolledBack?'The update failed. Your previous version has been restored. Please try again.':'The update could not finish. Please try again or reinstall the connector.',detail:receipt.error,progress:null});
      return state;
    }
  };
}
