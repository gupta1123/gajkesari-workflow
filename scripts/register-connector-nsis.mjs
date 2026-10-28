import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareNsisTemplates} from './connector-nsis-templates.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(repo, 'installer/tally-bridge/nsis');
const require = createRequire(path.join(tools, 'package.json'));
// Initialise the public entry point first; deep-loading a target first creates
// a circular dependency through PlatformPackager in electron-builder.
require('app-builder-lib');
const {NsisTarget} = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
const original = NsisTarget.prototype.computeFinalScript;
// Keep the normal signing, integrity validation and blockmap pipeline. Only
// redirect the file-install section; don't use a standalone custom NSIS script.
NsisTarget.prototype.computeFinalScript = async function(script, installer, archs) {
  if (installer) {
    const generated = prepareNsisTemplates(tools, this.outDir);
    const needle = '!include "installSection.nsh"';
    if (script.split(needle).length !== 2) throw new Error('Unexpected NSIS main template.');
    script = script.replace(needle, `!include "${path.join(generated, 'installSection.nsh')}"`);
  }
  return original.call(this, script, installer, archs);
};
