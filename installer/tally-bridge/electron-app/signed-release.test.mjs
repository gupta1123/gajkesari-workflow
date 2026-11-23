import {test} from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import {verifyRelease} from "./signed-release.mjs";
test("signed release binds the installer checksum, product, size and exact version",()=>{
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const version="0.1.97",manifest=JSON.stringify({version,product:"gajkesari-operator-nsis-x64",size:10,sha256:"a".repeat(64)});
  const signature=sign(null,Buffer.from(manifest),privateKey).toString("base64");
  assert.equal(verifyRelease({manifest,signature},version,publicKey).size,10);
  assert.throws(()=>verifyRelease({manifest:manifest.replace("10","11"),signature},version,publicKey));
  assert.throws(()=>verifyRelease({manifest,signature},"0.1.98",publicKey));
});
