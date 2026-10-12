; Inno Setup script for the Foundry release proxy (Windows).
;
; Build:  packaging\windows\build-installer.ps1   (downloads Node.js, then runs ISCC with the defines below)
;   ISCC /DAppVersion=1.2.3 [/DRepoRoot=<source folder>] /DNodeExe=<node.exe> /DNodeLicense=<LICENSE> /O<out dir> foundry-release-proxy.iss
;
; The installer is a wizard around scripts\install-service.ps1: it copies the code to
; C:\Program Files\FoundryReleaseProxy, installs a private Node.js next to it (the proxy runs as LOCAL SERVICE, so
; it cannot use a node.exe from a user profile), writes config.json from the wizard answers and then runs
; install-service.ps1, which creates the data folder with its ACLs, env, admin.json (admin page password and update
; e-mails), the scheduled task and (optionally) the auto-updater. Existing config.json, env and admin.json are never
; overwritten, so running the installer again updates the code.
;
; Silent install (passwords and the token only through the environment, never on the command line):
;   set FOUNDRY_PROXY_GITHUB_TOKEN=github_pat_...
;   set FOUNDRY_PROXY_ADMIN_PASSWORD=...          (optional: turns on the admin page)
;   set FOUNDRY_PROXY_SMTP_PASSWORD=...           (optional)
;   foundry-release-proxy-X.Y.Z-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /MODULEID=transformations /REPO=owner/name /AUTOUPDATE=1
;     [/NOTIFYEMAILS=a@example.com,b@example.com /SMTPHOST=smtp.example.com /SMTPPORT=587 /SMTPSECURITY=starttls
;      /SMTPUSER=user /SMTPFROM=proxy@example.com]
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
; The files to pack: this repository, or (release builds) the unpacked Windows archive with the version stamped in.
#ifndef RepoRoot
  #define RepoRoot "..\.."
#endif

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
OutputBaseFilename=foundry-release-proxy-{#AppVersion}-setup
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
  AdminPage: TInputQueryWizardPage;
  SmtpPage: TInputQueryWizardPage;

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

function AdminFile: String;
begin
  Result := DataDir + '\admin.json';
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

function WantsNotify: Boolean;
begin
  Result := Trim(AdminPage.Values[2]) <> '';
end;

// A rough check of the comma separated addresses (src\admin.js does the real validation).
function EmailsLookValid(S: String): Boolean;
var
  Item: String;
  I: Integer;
begin
  Result := True;
  S := S + ',';
  while S <> '' do
  begin
    I := Pos(',', S);
    Item := Trim(Copy(S, 1, I - 1));
    S := Copy(S, I + 1, Length(S));
    if (Item <> '') and ((Pos('@', Item) < 2) or (Pos('.', Item) = 0) or (Pos(' ', Item) > 0)) then Result := False;
  end;
end;

// Returns '' when the admin page password and the addresses are usable, otherwise a message for the user.
function AdminError: String;
begin
  Result := '';
  if FileExists(AdminFile) then Exit;
  if (AdminPage.Values[0] <> '') and (Length(AdminPage.Values[0]) < 8) then
    Result := 'The admin page password needs at least 8 characters (or leave it empty to keep the page off).'
  else if AdminPage.Values[0] <> AdminPage.Values[1] then
    Result := 'The two admin page passwords differ.'
  else if not EmailsLookValid(AdminPage.Values[2]) then
    Result := 'Enter the notification e-mail addresses separated by commas, like a@example.com, b@example.org.';
end;

// Returns '' when the mail server answers are usable (or not needed), otherwise a message for the user.
function SmtpError: String;
var
  Port: Integer;
begin
  Result := '';
  if FileExists(AdminFile) then Exit;
  if WantsNotify then
  begin
    Port := StrToIntDef(Trim(SmtpPage.Values[1]), 0);
    if Trim(SmtpPage.Values[0]) = '' then
      Result := 'Enter the SMTP server that sends the notification e-mails.'
    else if (Port < 1) or (Port > 65535) then
      Result := 'The SMTP port must be a number between 1 and 65535.'
    else if (Trim(SmtpPage.Values[2]) <> 'starttls') and (Trim(SmtpPage.Values[2]) <> 'tls') and
      (Trim(SmtpPage.Values[2]) <> 'none') then
      Result := 'SMTP security must be starttls, tls or none.'
    else if (Trim(SmtpPage.Values[3]) <> '') and (Trim(SmtpPage.Values[2]) = 'none') then
      Result := 'A login (user name) needs SMTP security starttls or tls.'
    else if not EmailsLookValid(Trim(SmtpPage.Values[5])) or (Trim(SmtpPage.Values[5]) = '') then
      Result := 'Enter the sender (From) address of the notification e-mails.';
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

  AdminPage := CreateInputQueryPage(UpdatePage.ID, 'Administration page and e-mails',
    'Manage modules in a browser and get update e-mails',
    'Optional. With a password the proxy serves an administration page at http://localhost:8787/_admin/ where ' +
    'you add, edit and delete modules and copy their links for Foundry. Leave the password empty to keep the page off. ' +
    'The e-mail addresses get a message whenever the proxy updates itself or an automatic update fails; both can be ' +
    'changed later on the administration page.');
  AdminPage.Add('Admin page password (at least 8 characters):', True);
  AdminPage.Add('Repeat the password:', True);
  AdminPage.Add('E-mail addresses for update notifications (comma separated):', False);
  AdminPage.Values[0] := GetEnv('FOUNDRY_PROXY_ADMIN_PASSWORD');
  AdminPage.Values[1] := GetEnv('FOUNDRY_PROXY_ADMIN_PASSWORD');
  AdminPage.Values[2] := ExpandConstant('{param:NOTIFYEMAILS|}');

  SmtpPage := CreateInputQueryPage(AdminPage.ID, 'Mail server',
    'The SMTP server that sends the notification e-mails',
    'Security: starttls (usually port 587), tls (usually port 465) or none (a local relay without login). ' +
    'The settings are stored in ' + DataDir + '\admin.json, readable only by administrators and the proxy.');
  SmtpPage.Add('SMTP server (e.g. smtp.gmail.com):', False);
  SmtpPage.Add('Port:', False);
  SmtpPage.Add('Security (starttls, tls or none):', False);
  SmtpPage.Add('User name (empty = no login):', False);
  SmtpPage.Add('Password:', True);
  SmtpPage.Add('Sender address (From):', False);
  SmtpPage.Values[0] := ExpandConstant('{param:SMTPHOST|}');
  SmtpPage.Values[1] := ExpandConstant('{param:SMTPPORT|587}');
  SmtpPage.Values[2] := ExpandConstant('{param:SMTPSECURITY|starttls}');
  SmtpPage.Values[3] := ExpandConstant('{param:SMTPUSER|}');
  SmtpPage.Values[4] := GetEnv('FOUNDRY_PROXY_SMTP_PASSWORD');
  SmtpPage.Values[5] := ExpandConstant('{param:SMTPFROM|}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Nothing to ask when the token and the config already exist (a re-install or update).
  Result := ((PageID = SettingsPage.ID) and FileExists(EnvFile) and FileExists(ConfigFile)) or
    // admin.json exists: its settings are changed on the admin page (or install-service.ps1 -SetAdminPassword)
    (((PageID = AdminPage.ID) or (PageID = SmtpPage.ID)) and FileExists(AdminFile)) or
    ((PageID = SmtpPage.ID) and not WantsNotify);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Msg: String;
begin
  Result := True;
  Msg := '';
  if CurPageID = SettingsPage.ID then Msg := SettingsError
  else if CurPageID = AdminPage.ID then Msg := AdminError
  else if CurPageID = SmtpPage.ID then Msg := SmtpError;
  if Msg <> '' then
  begin
    MsgBox(Msg, mbError, MB_OK);
    Result := False;
  end;
end;

// Stops the proxy (the old node.exe would be locked) and re-checks the answers for silent installs.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := SettingsError;
  if Result = '' then Result := AdminError;
  if Result = '' then Result := SmtpError;
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

// Hands the admin page and e-mail answers to install-service.ps1 (which writes admin.json only when it is missing).
procedure SetAdminEnvironment(Clear: Boolean);
var
  I: Integer;
  Names: array[0..7] of String;
  Values: array[0..7] of String;
begin
  Names[0] := 'FOUNDRY_PROXY_ADMIN_PASSWORD'; Values[0] := AdminPage.Values[0];
  Names[1] := 'FOUNDRY_PROXY_NOTIFY_EMAILS'; Values[1] := Trim(AdminPage.Values[2]);
  Names[2] := 'FOUNDRY_PROXY_SMTP_HOST'; Values[2] := Trim(SmtpPage.Values[0]);
  Names[3] := 'FOUNDRY_PROXY_SMTP_PORT'; Values[3] := Trim(SmtpPage.Values[1]);
  Names[4] := 'FOUNDRY_PROXY_SMTP_SECURITY'; Values[4] := Trim(SmtpPage.Values[2]);
  Names[5] := 'FOUNDRY_PROXY_SMTP_USER'; Values[5] := Trim(SmtpPage.Values[3]);
  Names[6] := 'FOUNDRY_PROXY_SMTP_PASSWORD'; Values[6] := SmtpPage.Values[4];
  Names[7] := 'FOUNDRY_PROXY_SMTP_FROM'; Values[7] := Trim(SmtpPage.Values[5]);
  for I := 0 to 7 do
  begin
    // the mail server settings only matter with recipients
    if Clear or ((I >= 2) and not WantsNotify) then Values[I] := '';
    SetEnvironmentVariableW(Names[I], Values[I]);
  end;
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
  SetAdminEnvironment(False);
  try
    if not Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      ResultCode := -1;
  finally
    SetEnvironmentVariableW('FOUNDRY_PROXY_GITHUB_TOKEN', '');
    SetAdminEnvironment(True);
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
