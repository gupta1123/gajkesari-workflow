#define AppName "Gajkesari Tally Connector"
#define AppVersion "0.1.0"
#define AppPublisher "Gajkesari"
#define AppInstallDir "C:\Gajkesari\tally-bridge"

[Setup]
AppId={{C3B8D6B9-7F0E-42C6-A142-8706167053EC}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={#AppInstallDir}
DisableProgramGroupPage=yes
OutputDir=output
UsePreviousAppDir=no
OutputBaseFilename=GajkesariTallyConnectorSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "payload-clean\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Classes\gajkesari-tally"; ValueType: string; ValueName: ""; ValueData: "URL:Gajkesari Tally Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\gajkesari-tally"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\gajkesari-tally\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\Gajkesari Tally Connector.exe,0"
Root: HKCU; Subkey: "Software\Classes\gajkesari-tally\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Gajkesari Tally Connector.exe"" ""%1"""
