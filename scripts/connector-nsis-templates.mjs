import fs from 'node:fs';
import path from 'node:path';

export function prepareNsisTemplates(tools, output) {
  const upstream = path.join(tools, 'node_modules/app-builder-lib');
  if (JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'))).version !== '26.18.0') {
    throw new Error('Review the installer template changes before upgrading electron-builder.');
  }
  const templates = path.join(upstream, 'templates/nsis');
  const generated = path.join(output, 'templates');
  fs.mkdirSync(generated, {recursive:true});
  const replace = (text, needle, value) => {
    if (text.split(needle).length !== 2) throw new Error(`NSIS template changed: ${needle}`);
    return text.replace(needle, value);
  };
  let extract = fs.readFileSync(path.join(templates, 'include/extractAppPackage.nsh'), 'utf8');
  const macro = extract.indexOf('!macro extractUsing7za FILE');
  if (macro < 0 || extract.slice(macro).trim().split('!macroend').length !== 2) throw new Error('Unexpected NSIS extraction template.');
  extract = extract.slice(0, macro) + fs.readFileSync(path.join(tools, 'extract-app-fast.nsh'), 'utf8');
  fs.writeFileSync(path.join(generated, 'extract.nsh'), extract);
  let installer = fs.readFileSync(path.join(templates, 'include/installer.nsh'), 'utf8');
  installer = replace(installer, '!include "extractAppPackage.nsh"', `!include "${path.join(generated, 'extract.nsh')}"`);
  installer = replace(installer, '      !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"', '      !insertmacro GajkesariStage "Saving the update cache..."\n      !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"');
  fs.writeFileSync(path.join(generated, 'installer.nsh'), installer);
  let section = fs.readFileSync(path.join(templates, 'installSection.nsh'), 'utf8');
  section = replace(section, '!include installer.nsh', `!include "${path.join(generated, 'installer.nsh')}"`);
  section = replace(section, '!insertmacro uninstallOldVersion SHELL_CONTEXT', '!insertmacro GajkesariStage "Removing the previous connector version..."\n!insertmacro uninstallOldVersion SHELL_CONTEXT');
  fs.writeFileSync(path.join(generated, 'installSection.nsh'), section);
  return generated;
}
