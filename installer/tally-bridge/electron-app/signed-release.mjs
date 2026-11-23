import fs from "node:fs";
import path from "node:path";
import {createHash,verify,randomUUID} from "node:crypto";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import {compareVersions} from "./updates.mjs";

export function verifyRelease(envelope,version,key){
  if(typeof envelope?.manifest!=="string" || envelope.manifest.length>3000 ||
    !verify(null,Buffer.from(envelope.manifest),key,Buffer.from(envelope.signature||"","base64")))
    throw Error("Connector release signature is invalid.");
  const m=JSON.parse(envelope.manifest);
  if(m.product!=="gajkesari-operator-nsis-x64"||m.version!==version||!Number.isSafeInteger(m.size)||m.size<1||
    m.size>1024**3||!/^[a-f0-9]{64}$/.test(m.sha256))throw Error("Release does not match the selected connector version.");
  return m;
}
export async function stageRelease(version,currentVersion,directory,key,signal){
  if(compareVersions(version,currentVersion)<=0)throw Error("Choose a newer published release.");
  const base="https://github.com/gupta1123/gajkesari-workflow/releases/download/operator-connector-v"+version+"/";
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(6*60_000)]);
  const response=await fetch(base+"operator-release.json",{signal:bounded});
  if(!response.ok)throw Error("Signed release manifest unavailable.");
  const m=verifyRelease(await response.json(),version,key);
  fs.mkdirSync(directory,{recursive:true});
  const installer=path.join(directory,"operator-"+version+".exe");
  const temp=installer+"."+randomUUID()+".tmp";
  const file=await fetch(base+"GajkesariTallyConnectorSetup-"+version+".exe",{signal:bounded});
  if(!file.ok||!file.body)throw Error("Release download failed.");
  let size=0;const hash=createHash("sha256");
  try{
    await pipeline(Readable.fromWeb(file.body),new Transform({transform(bytes,encoding,done){
      size+=bytes.length;if(size>m.size)return done(Error("Unexpected release size."));
      hash.update(bytes);done(null,bytes);
    }}),fs.createWriteStream(temp,{flags:"wx"}),{signal:bounded});
    if(size!==m.size||hash.digest("hex")!==m.sha256)throw Error("Installer verification failed.");
    fs.renameSync(temp,installer);
    return {installer,version,sha256:m.sha256};
  }finally{fs.rmSync(temp,{force:true});}
}
