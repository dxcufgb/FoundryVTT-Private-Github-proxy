; Inno Setup script for the Foundry release proxy (Windows).
;
; Build:  packaging\windows\build-installer.ps1   (downloads Node.js, then runs ISCC with the defines below)
;   ISCC /DAppVersion=1.2.3 /DNodeExe=<node.exe> /DNodeLicense=<LICENSE> /O<out dir> foundry-release-proxy.iss
;
; The installer is a wizard around scripts\install-service.ps1: it copies the code to
; C:\Program Files\FoundryReleaseProxy, installs a private Node.js next to it (the proxy runs as LOCAL SERVICE, so
; it cannot use a node.exe from a user profile), writes config.json from the wizard answers and then runs
; install-service.ps1, which creates the data folder with its ACLs, env, the scheduled task and (optionally) the
; auto-updater. Existing config.json and env are never overwritten, so running the installer again updates the code.
;
; Silent install:
;   set FOUNDRY_PROXY_GITHUB_TOKEN=github_pat_...
;   FoundryReleaseProxy-Setup-X.Y.Z.exe /VERYSILENT /SUPPRESSMSGBOXES /MODULEID=transformations /REPO=owner/name /AUTOUPDATE=1
; Silent uninstall keeps config and token; add /DELETEDATA=1 to remove C:\ProgramData\FoundryReleaseProxy as well.

#ifndef AppVersion
  #error Pass /DAppVersion=MAJOR.MINOR.PATCH
#endif
#ifndef NodeExe
  #error Pass /DNodeExe=path\to\node.exe
#endif
#ifndef NodeLicense
  #error Pass /DNodeLicense=path\to\node\LICENSE
#endif

#define AppName "Foundry Release Proxy"
#define DataFolder "FoundryReleaseProxy"
#define NodeFolder "FoundryReleaseProxy-Node"
#define RepoRoot "..\.."

[Setup]
AppId={{C8D7F34D-E87D-4D25-930B-EDDD67F22470}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=dxcufgb
AppPublisherURL=https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy
; install-service.ps1 and the updater expect the code in C:\Program Files\FoundryReleaseProxy, so the folder is fixed.
DefaultDirName={commonpf}\{#DataFolder}
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
OutputBaseFilename=FoundryReleaseProxy-Setup-{#AppVersion}
UninstallDisplayName={#AppName}
; The proxy is stopped by PrepareToInstall; there is no application window for Restart Manager to close.
CloseApplications=no
RestartApplications=no

[Files]
Source: "{#RepoRoot}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs
Source: "{#RepoRoot}\scripts\*.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#RepoRoot}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\.env.example"; DestDir: "{app}"; Flags: ignoreversion
; Node.js lives outside {app}: the auto-updater replaces the whole code folder.
Source: "{#NodeExe}"; DestDir: "{commonpf}\{#NodeFolder}"; Flags: ignoreversion
Source: "{#NodeLicense}"; DestDir: "{commonpf}\{#NodeFolder}"; DestName: "Node.js-LICENSE.txt"; Flags: ignoreversion
Source: "stop-proxy.ps1"; Flags: dontcopy

[UninstallDelete]
; The updater and install-service.ps1 write into these after Inno recorded its own files.
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{app}.prev"
Type: filesandordirs; Name: "{commonpf}\{#NodeFolder}"

[Code]
var
  SettingsPage: TInputQueryWizardPage;
  UpdatePage: TInputOptionWizardPage;

function SetEnvironmentVariableW(Name, Value: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function DataDir: String;
begin
  Result := ExpandConstant('{commonappdata}\{#DataFolder}');
end;

function EnvFile: String;
begin
  Result := DataDir + '\env';
end;

function ConfigFile: String;
begin
  Result := DataDir + '\config.json';
end;

function PowerShellExe: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function NodeExePath: String;
begin
  Result := ExpandConstant('{commonpf}\{#NodeFolder}\node.exe');
end;

function IsIdChar(C: Char; AllowDot: Boolean): Boolean;
begin
  Result := ((C >= 'a') and (C <= 'z')) or ((C >= 'A') and (C <= 'Z')) or ((C >= '0') and (C <= '9')) or
    (C = '_') or (C = '-') or (AllowDot and (C = '.'));
end;

// Same rules as the proxy's MODULE_ID_RE: letters, digits, "-" and "_", starting with a letter or digit.
function IsValidModuleId(S: String): Boolean;
var
  I: Integer;
begin
  Result := S <> '';
  if not Result then Exit;
  if (S[1] = '_') or (S[1] = '-') then Result := False;
  for I := 1 to Length(S) do
    if not IsIdChar(S[I], False) then Result := False;
end;

// owner/name with letters, digits, "-", "_" and "." on both sides (the proxy's REPO_RE).
function IsValidRepo(S: String): Boolean;
var
  Slash, I: Integer;
begin
  Slash := Pos('/', S);
  Result := (Slash > 1) and (Slash < Length(S));
  if not Result then Exit;
  for I := 1 to Length(S) do
    if I <> Slash then
      if not IsIdChar(S[I], True) then Result := False;
end;

function WantsModule: Boolean;
begin
  Result := (Trim(SettingsPage.Values[1]) <> '') or (Trim(SettingsPage.Values[2]) <> '');
end;

// Returns '' when the wizard answers are usable, otherwise a message for the user.
function SettingsError: String;
begin
  Result := '';
  if (not FileExists(EnvFile)) and (Trim(SettingsPage.Values[0]) = '') then
    Result := 'Enter the GitHub token (a fine-grained token with Contents: read-only on the module repositories).'
  else if (not FileExists(ConfigFile)) and WantsModule then
  begin
    if not IsValidModuleId(Trim(SettingsPage.Values[1])) then
      Result := 'The module id may only contain letters, digits, "-" and "_".'
    else if not IsValidRepo(Trim(SettingsPage.Values[2])) then
      Result := 'The repository must look like owner/name.';
  end;
end;

function AutoUpdateWasOn: Boolean;
var
  Text: AnsiString;
begin
  Result := LoadStringFromFile(DataDir + '\auto-update.conf', Text) and (Pos('AUTO_UPDATE=yes', String(Text)) > 0);
end;

procedure InitializeWizard;
begin
  SettingsPage := CreateInputQueryPage(wpWelcome, 'GitHub access',
    'The token and the first module',
    'The token is stored in ' + DataDir + '\env, readable only by administrators and the proxy. ' +
    'Existing settings are never overwritten.');
  SettingsPage.Add('GitHub token (fine-grained, Contents: read-only on the module repositories):', True);
  SettingsPage.Add('Module id (the name in the manifest URL, e.g. transformations):', False);
  SettingsPage.Add('GitHub repository of that module (owner/name):', False);
  SettingsPage.Values[0] := GetEnv('FOUNDRY_PROXY_GITHUB_TOKEN');
  SettingsPage.Values[1] := ExpandConstant('{param:MODULEID|transformations}');
  SettingsPage.Values[2] := ExpandConstant('{param:REPO|dxcufgb/FoundryVTT-ghpg-Transformations}');

  UpdatePage := CreateInputOptionPage(SettingsPage.ID, 'Automatic updates',
    'Keep the proxy itself up to date',
    'Optional. The proxy checks the GitHub releases of this project once a day and installs newer versions. ' +
    'It uses the token above, so that token also needs Contents: read-only on dxcufgb/FoundryVTT-Private-Github-proxy.',
    False, False);
  UpdatePage.Add('Turn on automatic updates');
  UpdatePage.Values[0] := (ExpandConstant('{param:AUTOUPDATE|0}') = '1') or AutoUpdateWasOn;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Nothing to ask when the token and the config already exist (a re-install or update).
  Result := (PageID = SettingsPage.ID) and FileExists(EnvFile) and FileExists(ConfigFile);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Msg: String;
begin
  Result := True;
  if CurPageID = SettingsPage.ID then
  begin
    Msg := SettingsError;
    if Msg <> '' then
    begin
      MsgBox(Msg, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// Stops the proxy (the old node.exe would be locked) and re-checks the answers for silent installs.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := SettingsError;
  if Result <> '' then Exit;
  ExtractTemporaryFile('stop-proxy.ps1');
  Exec(PowerShellExe, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\stop-proxy.ps1') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure WriteInitialConfig;
var
  Json: String;
begin
  if FileExists(ConfigFile) or not WantsModule then Exit;
  ForceDirectories(DataDir);
  // (No line may start with #: the preprocessor would take it for a directive.)
  Json := '{' + #13#10 + '  "' + Trim(SettingsPage.Values[1]) + '": { "repo": "' + Trim(SettingsPage.Values[2]) + '" }' + #13#10 + '}' + #13#10;
  // Both values were checked above, so they contain no characters that need escaping.
  SaveStringToFile(ConfigFile, AnsiString(Json), False);
end;

procedure RunInstallScript;
var
  Script, LogFile, Switch, Params: String;
  ResultCode: Integer;
begin
  Script := ExpandConstant('{app}\scripts\install-service.ps1');
  LogFile := ExpandConstant('{app}\install.log');
  if UpdatePage.Values[0] then Switch := '-AutoUpdate' else Switch := '-NoAutoUpdate';
  // -Upgrade = never prompt; the token reaches the script through the environment, not the command line.
  Params := '/d /s /c ""' + PowerShellExe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script +
    '" -Upgrade -NodePath "' + NodeExePath + '" ' + Switch + ' > "' + LogFile + '" 2>&1"';
  SetEnvironmentVariableW('FOUNDRY_PROXY_GITHUB_TOKEN', Trim(SettingsPage.Values[0]));
  try
    if not Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      ResultCode := -1;
  finally
    SetEnvironmentVariableW('FOUNDRY_PROXY_GITHUB_TOKEN', '');
  end;
  if ResultCode <> 0 then
    MsgBox('Setting up the proxy failed (exit code ' + IntToStr(ResultCode) + '). Details: ' + LogFile,
      mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteInitialConfig;
    RunInstallScript;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Script: String;
  ResultCode: Integer;
  Delete: Boolean;
begin
  if CurUninstallStep = usUninstall then
  begin
    // Removes the scheduled tasks and kills the running proxy so its files can be deleted.
    Script := ExpandConstant('{app}\scripts\install-service.ps1');
    if FileExists(Script) then
      Exec(PowerShellExe, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script + '" -Uninstall',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(DataDir) then
    begin
      if UninstallSilent then
        Delete := ExpandConstant('{param:DELETEDATA|0}') = '1'
      else
        Delete := MsgBox('Also delete the configuration, token and logs in ' + DataDir + '?',
          mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
      if Delete then DelTree(DataDir, True, True, True);
    end;
  end;
end;
