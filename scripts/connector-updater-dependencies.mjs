import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

export function copyUpdaterDependencies(from, destination) {
  function copy(name, parent, target, ancestors) {
    const req = createRequire(path.join(parent, 'package.json'));
    const source = path.dirname(req.resolve(`${name}/package.json`));
    if (ancestors.get(name) === source) return;
    const output = path.join(target, name);
    fs.cpSync(source, output, {recursive: true});
    const next = new Map(ancestors).set(name, source);
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(metadata.dependencies || {})) copy(dependency, source, path.join(output, 'node_modules'), next);
  }
  copy('electron-updater', from, destination, new Map());
}
