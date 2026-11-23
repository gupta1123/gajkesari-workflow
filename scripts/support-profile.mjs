import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export function profilePath() {
  if (process.platform !== "win32")
    throw Error("The CLI credential profile requires Windows.");
  return join(
    process.env.LOCALAPPDATA,
    "Gajkesari",
    "OperatorCLI",
    "profile.dpapi",
  );
}
function transform(input, decrypt) {
  const operation = decrypt
    ? "$s=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); [Console]::Write(([pscredential]::new('support',$s)).GetNetworkCredential().Password)"
    : "$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; [Console]::Write((ConvertFrom-SecureString $s))";
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; " + operation,
    ],
    { input, encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0 || !r.stdout)
    throw Error("Windows could not access the operator credential.");
  return r.stdout;
}
export function saveProfile(profile) {
  const file = profilePath();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, transform(JSON.stringify(profile), false), {
    flag: "wx",
  });
}
export function loadProfile() {
  return JSON.parse(transform(readFileSync(profilePath(), "utf8"), true));
}
