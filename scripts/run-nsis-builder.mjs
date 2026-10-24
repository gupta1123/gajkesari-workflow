import {execFileSync} from 'node:child_process';

export async function runNsisBuilder(cli, args, cwd) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const output = execFileSync(process.execPath, [cli, ...args], {cwd, encoding: 'utf8', windowsHide: true,
        maxBuffer: 8 * 1024 * 1024, env: {...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false'}});
      process.stdout.write(output);
      return;
    } catch (error) {
      const output = String(error.stdout || '') + String(error.stderr || '');
      process.stderr.write(output);
      // NSIS can briefly retain its generated bootstrap executable while
      // producing the final installer. Retry only this output-open failure.
      if (attempt > 0 || !output.includes("Can't open output file")) throw error;
      console.log('NSIS could not open its build output; retrying once after a short pause.');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}
