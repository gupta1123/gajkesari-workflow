import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const connector = {
  brandName: "Gajkesari",
  connectorName: "Gajkesari Tally Connector",
  executableName: "Gajkesari Tally Connector.exe",
  executableProcessName: "Gajkesari Tally Connector",
  setupName: "GajkesariTallyConnectorSetup.exe",
  protocolName: "gajkesari-tally",
  configFolderName: ".gajkesari-tally-bridge",
  installDir: "C:\\Gajkesari\\tally-bridge",
  runtimeEnvironmentVariable: "GAJKESARI_CONNECTOR_RUNTIME",
  tdlFileName: "gajkesari-native-debit-note-export.tdl",
  runtimePackageName: "@gajkesari/tally-bridge-runtime",
  tempFolderName: "gajkesari-tally-connector-installer",
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerRoot = path.join(repoRoot, "installer", "tally-bridge");
const electronAppSource = path.join(installerRoot, "electron-app");
const payloadDir = path.join(installerRoot, "payload-clean");
const outputDir = path.join(installerRoot, "output");
const outputExe = path.join(outputDir, connector.setupName);
const bridgeRoot = path.join(repoRoot, "apps", "tally-bridge");
const bridgeSource = path.join(bridgeRoot, "src", "bridge.mjs");
const webSocketPackageSource = path.join(repoRoot, "node_modules", "ws");
const powerShellSource = path.join(bridgeRoot, "powershell");
const samplesSource = path.join(bridgeRoot, "samples");
const tdlSource = path.join(bridgeRoot, "tdl");
const tdlFile = path.join(tdlSource, connector.tdlFileName);
const dashboardSource = path.join(
  repoRoot,
  "apps",
  "gajkesari-web",
  "src",
  "components",
  "tally",
  "TallyPrimeDashboard.tsx"
);
const innoDefinition = path.join(installerRoot, "gajkesari-tally-bridge.iss");
const tempBuildRoot = `C:\\tmp\\${connector.tempFolderName}`;
const stagingDir = path.join(tempBuildRoot, "staging");
const tempOutputDir = path.join(tempBuildRoot, "output");
const tempOutputExe = path.join(tempOutputDir, connector.setupName);
const payloadZip = path.join(stagingDir, "payload.zip");

function ensureFile(filePath, label = filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function ensureContains(filePath, expected, label) {
  ensureFile(filePath, label);
  const content = fs.readFileSync(filePath, "utf8");
  if (!content.includes(expected)) {
    throw new Error(`${label} does not contain ${JSON.stringify(expected)}: ${filePath}`);
  }
}

function validateSources() {
  ensureFile(bridgeSource, "Tally bridge source");
  ensureFile(path.join(webSocketPackageSource, "package.json"), "ws runtime dependency");
  ensureFile(path.join(electronAppSource, "main.mjs"), "Electron wrapper");
  ensureFile(path.join(electronAppSource, "package.json"), "Electron wrapper package");
  ensureFile(tdlFile, "native Tally PDF TDL");
  ensureContains(
    dashboardSource,
    `${connector.protocolName}://connect`,
    "Gajkesari web connector protocol"
  );
  ensureContains(
    bridgeSource,
    connector.configFolderName,
    "Gajkesari bridge configuration folder"
  );
  ensureContains(innoDefinition, connector.connectorName, "Inno Setup product name");
  ensureContains(innoDefinition, connector.protocolName, "Inno Setup protocol");
  ensureContains(
    path.join(electronAppSource, "main.mjs"),
    connector.connectorName,
    "Electron product name"
  );
  console.log(
    `Installer sources validated for ${connector.connectorName} (${connector.protocolName}://).`
  );
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(source, destination) {
  if (fs.existsSync(source)) {
    fs.cpSync(source, destination, { recursive: true, force: true });
  }
}

function findRuntimeExecutable(runtimeSource) {
  const preferredNames = [connector.executableName, "electron.exe"];
  for (const name of preferredNames) {
    const candidate = path.join(runtimeSource, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  if (!fs.existsSync(runtimeSource)) return null;
  const candidates = fs
    .readdirSync(runtimeSource, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .filter((entry) => !/(setup|unins|update|squirrel)/i.test(entry.name));
  return candidates.length === 1 ? path.join(runtimeSource, candidates[0].name) : null;
}

function findRuntime() {
  const candidates = [
    process.env[connector.runtimeEnvironmentVariable],
    connector.installDir,
    process.env.KALIKA_CONNECTOR_RUNTIME,
    "C:\\Autodealer\\tally-bridge",
  ].filter(Boolean);

  for (const runtimeSource of candidates) {
    const executable = findRuntimeExecutable(runtimeSource);
    if (executable) return { runtimeSource, executable };
  }

  throw new Error(
    `Missing Electron runtime. Set ${connector.runtimeEnvironmentVariable} to an Electron runtime directory.`
  );
}

function findInnoCompiler() {
  const candidates = [
    process.env.INNO_SETUP_COMPILER,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].filter(Boolean);
  const compiler = candidates.find((candidate) => fs.existsSync(candidate));
  if (!compiler) {
    throw new Error("Inno Setup 6 compiler was not found. Install JRSoftware.InnoSetup or set INNO_SETUP_COMPILER.");
  }
  return compiler;
}

function copyOptionalRuntimeFile(runtimeSource, name) {
  const source = path.join(runtimeSource, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(payloadDir, name));
}

function writeInstallFiles() {
  const installCmd = `@echo off\r\nsetlocal\r\nnet session >nul 2>&1\r\nif %ERRORLEVEL% NEQ 0 (\r\n  "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait"\r\n  exit /b %ERRORLEVEL%\r\n)\r\nset SCRIPT_DIR=%~dp0\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1"\r\nexit /b %ERRORLEVEL%\r\n`;

  const installPs1 = String.raw`$ErrorActionPreference = "Stop"

$installDir = "${connector.installDir}"
$configDir = Join-Path $env:USERPROFILE "${connector.configFolderName}"
$payloadZip = Join-Path $PSScriptRoot "payload.zip"
$payloadExtract = Join-Path $env:TEMP "${connector.tempFolderName}-payload"
$nativePdfTdl = Join-Path $installDir "tdl\${connector.tdlFileName}"
$tallyInstallDir = Join-Path $env:ProgramFiles "TallyPrime"
$tallyTdl = Join-Path $tallyInstallDir "${connector.tdlFileName}"

Write-Host "Closing old ${connector.connectorName} instances..."
Get-Process -Name "${connector.executableProcessName}" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

Write-Host "Preserving connector pairing at $configDir"
Write-Host "Preparing clean install folder..."
if (Test-Path $installDir) {
  Remove-Item -LiteralPath $installDir -Recurse -Force
}
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

Write-Host "Extracting connector files..."
if (Test-Path $payloadExtract) {
  Remove-Item -LiteralPath $payloadExtract -Recurse -Force
}
Expand-Archive -LiteralPath $payloadZip -DestinationPath $payloadExtract -Force
Copy-Item -Path (Join-Path $payloadExtract "*") -Destination $installDir -Recurse -Force

Write-Host "Preparing the native Tally PDF add-on..."
if (Test-Path $nativePdfTdl) {
  try {
    Copy-Item -LiteralPath $nativePdfTdl -Destination $tallyTdl -Force
    Write-Host "TDL available in TallyPrime: $tallyTdl"
  } catch {
    Write-Warning "Could not copy the TDL into TallyPrime. Select it once from: $nativePdfTdl"
  }
}

Write-Host "Registering ${connector.brandName} connect link..."
$protocolRoot = "HKCU:\Software\Classes\${connector.protocolName}"
New-Item -Path $protocolRoot -Force | Out-Null
Set-Item -Path $protocolRoot -Value "URL:${connector.brandName} Tally Protocol"
New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path "$protocolRoot\DefaultIcon" -Force | Out-Null
Set-Item -Path "$protocolRoot\DefaultIcon" -Value "$installDir\${connector.executableName},0"
New-Item -Path "$protocolRoot\shell\open\command" -Force | Out-Null
$openCommand = '"' + (Join-Path $installDir "${connector.executableName}") + '" "%1"'
Set-Item -Path "$protocolRoot\shell\open\command" -Value $openCommand

Write-Host "Starting connector..."
Start-Process -FilePath "$installDir\${connector.executableName}"
Write-Host "${connector.connectorName} installed successfully."
`;

  fs.writeFileSync(path.join(stagingDir, "install.cmd"), installCmd);
  fs.writeFileSync(path.join(stagingDir, "install.ps1"), installPs1);
}

function writeSedFile() {
  const sedPath = path.join(stagingDir, `${connector.protocolName}-connector.sed`);
  const sed = `[Version]\r\nClass=IEXPRESS\r\nSEDVersion=3\r\n\r\n[Options]\r\nPackagePurpose=InstallApp\r\nShowInstallProgramWindow=1\r\nHideExtractAnimation=1\r\nUseLongFileName=1\r\nInsideCompressed=0\r\nCAB_FixedSize=0\r\nCAB_ResvCodeSigning=0\r\nRebootMode=N\r\nInstallPrompt=%InstallPrompt%\r\nDisplayLicense=\r\nFinishMessage=%FinishMessage%\r\nTargetName=%TargetName%\r\nFriendlyName=%FriendlyName%\r\nAppLaunched=%AppLaunched%\r\nPostInstallCmd=<None>\r\nAdminQuietInstCmd=\r\nUserQuietInstCmd=\r\nSourceFiles=SourceFiles\r\n\r\n[Strings]\r\nInstallPrompt=\r\nFinishMessage=\r\nTargetName=${tempOutputExe}\r\nFriendlyName=${connector.connectorName} Setup\r\nAppLaunched=install.cmd\r\nFILE0=install.cmd\r\nFILE1=install.ps1\r\nFILE2=payload.zip\r\n\r\n[SourceFiles]\r\nSourceFiles0=${stagingDir}\r\n\r\n[SourceFiles0]\r\n%FILE0%=\r\n%FILE1%=\r\n%FILE2%=\r\n`;
  fs.writeFileSync(sedPath, sed);
  return sedPath;
}

validateSources();
if (process.argv.includes("--validate")) process.exit(0);
if (process.platform !== "win32") {
  throw new Error("The setup executable must be built on Windows because it uses Inno Setup.");
}

const { runtimeSource, executable: runtimeExecutable } = findRuntime();
const innoCompiler = findInnoCompiler();

resetDir(payloadDir);
resetDir(stagingDir);
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(tempOutputDir, { recursive: true });

fs.copyFileSync(runtimeExecutable, path.join(payloadDir, connector.executableName));
for (const name of [
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "d3dcompiler_47.dll",
  "ffmpeg.dll",
  "icudtl.dat",
  "libEGL.dll",
  "libGLESv2.dll",
  "LICENSE.electron.txt",
  "LICENSES.chromium.html",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "vk_swiftshader.dll",
  "vk_swiftshader_icd.json",
  "vulkan-1.dll",
]) {
  copyOptionalRuntimeFile(runtimeSource, name);
}

copyDir(path.join(runtimeSource, "locales"), path.join(payloadDir, "locales"));
copyDir(powerShellSource, path.join(payloadDir, "powershell"));
copyDir(samplesSource, path.join(payloadDir, "samples"));
copyDir(tdlSource, path.join(payloadDir, "tdl"));

const appDir = path.join(payloadDir, "resources", "app");
fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
fs.copyFileSync(path.join(electronAppSource, "main.mjs"), path.join(appDir, "main.mjs"));
fs.copyFileSync(path.join(electronAppSource, "package.json"), path.join(appDir, "package.json"));
fs.copyFileSync(bridgeSource, path.join(appDir, "src", "bridge.mjs"));
copyDir(webSocketPackageSource, path.join(appDir, "node_modules", "ws"));
fs.writeFileSync(
  path.join(payloadDir, "package.json"),
  `${JSON.stringify(
    {
      name: connector.runtimePackageName,
      version: "0.1.57",
      private: true,
      type: "module",
    },
    null,
    2
  )}\n`
);

if (fs.existsSync(outputExe)) fs.rmSync(outputExe, { force: true });
execFileSync(innoCompiler, [innoDefinition], {
  cwd: installerRoot,
  stdio: "inherit",
});
if (!fs.existsSync(outputExe)) throw new Error("Inno Setup did not create the setup executable.");
console.log(`Installer created: ${outputExe}`);
