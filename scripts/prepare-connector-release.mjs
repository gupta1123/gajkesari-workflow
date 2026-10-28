import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {RELEASE_PREFIX,UPDATE_REPOSITORY,compareVersions} from '../installer/tally-bridge/electron-app/updates.mjs';

export function prepareConnectorRelease({installer,version,outputDir}) {
  compareVersions(version,'0.0.0');
  if(!fs.statSync(installer).isFile())throw Error('Missing installer.');
  fs.mkdirSync(outputDir,{recursive:true});
  const name=`GajkesariTallyConnectorSetup-${version}.exe`;
  const output=path.join(outputDir,name);
  fs.copyFileSync(installer,output);
  const digest=createHash('sha256');
  const fd=fs.openSync(output,'r');const buffer=Buffer.alloc(1024*1024);let n;
  try{while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
  const manifest={schemaVersion:1,version,platform:'win32-x64',size:fs.statSync(output).size,sha256:digest.digest('hex'),
    url:`https://github.com/${UPDATE_REPOSITORY}/releases/download/${RELEASE_PREFIX}${version}/${name}`};
  fs.writeFileSync(path.join(outputDir,'connector-update.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const version=JSON.parse(fs.readFileSync(path.join(root,'installer/tally-bridge/electron-app/package.json'),'utf8')).version;
  console.log(JSON.stringify(prepareConnectorRelease({installer:path.join(root,'installer/tally-bridge/output/GajkesariTallyConnectorSetup.exe'),version,
    outputDir:path.join(root,'installer/tally-bridge/release')}),null,2));
}
