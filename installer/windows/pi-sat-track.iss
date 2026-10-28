; Pi Sat Track - Windows setup.exe (Inno Setup 6)
; Diagnose: pi-sat-track-...-setup.exe /LOG="%TEMP%\pst-setup.log"
; Build (see .github/workflows/build-win-setup.yml):
;   ISCC /DAppLabel=<branch>-alpha.<N> /O<outdir> /Fpi-sat-track-<branch>-alpha.<N>-setup pi-sat-track.iss
; install-win.bat / uninstall-win.bat remain the no-setup fallback.
;
; Installs to C:\Program Files\Pi Sat Track. Settings stay in %USERPROFILE%\.rpitrack.
; Node.js 22+ prerequisite: detected via HKLM\SOFTWARE\Node.js InstallPath (64/32-bit
; views), PATH and `node --version`. If missing or older than 22, the Ready page lists
; it; PrepareToInstall downloads the pinned official MSI (SHA-256 verified) and runs
; msiexec /i /qn /norestart /l*v. A newer Node is never touched.
; node_modules is built in CI and bundled (fallback: npm ci if missing). Then
; win-network.ps1 -Action Install (port 80 proxy + firewall rules TCP 80/3000).
; No service, no auto start: Start Menu shortcuts start / stop / open it.

#ifndef AppLabel
  #define AppLabel "dev"
#endif
#ifndef NodeVer
  #define NodeVer "22.23.4"
#endif
#ifndef NodeSha
  #define NodeSha "ca9303d3a12e8bec6de829fcb7812fc776930e0ce5c030328a24984ef928427e"
#endif
#define AppName "Pi Sat Track"
#define SrcRoot "..\.."

[Setup]
AppId={{6F1C2B7E-5A3D-4E8B-9C21-7D4A0E3B5F18}
AppName={#AppName}
AppVersion={#AppLabel}
AppVerName={#AppName} {#AppLabel}
AppPublisher=Pi Sat Track
AppPublisherURL=https://github.com/scubabri/pi-sat-track
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputBaseFilename=pi-sat-track-{#AppLabel}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={sys}\shell32.dll,13
VersionInfoVersion=0.1.0.0
VersionInfoTextVersion={#AppLabel}
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#SrcRoot}\*"; DestDir: "{app}"; \
  Excludes: "\.git,\.github,\.gitattributes,\.gitignore,\dist,\installer,\test,\tools,\*.run,\*.sh,\*.log"; \
  Flags: recursesubdirs createallsubdirs ignoreversion
Source: "start-sat-tracker.bat"; DestDir: "{app}"; Flags: ignoreversion

[INI]
Filename: "{app}\Open Pi Sat Track.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:3000/"

[Icons]
Name: "{group}\Start Pi Sat Track"; Filename: "{app}\start-sat-tracker.bat"; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 13
Name: "{group}\Stop Pi Sat Track"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\win-network.ps1"" -Action Stop -AppDir ""{app}"""; WorkingDir: "{app}"
Name: "{group}\Open Pi Sat Track"; Filename: "{app}\Open Pi Sat Track.url"
Name: "{group}\Uninstall Pi Sat Track"; Filename: "{uninstallexe}"

[Run]
; Started through 64-bit cmd.exe ({sys} in 64-bit mode): a shellexec from 32-bit setup
; got a 32-bit cmd where %ProgramFiles% = Program Files (x86), so node was not found.
Filename: "{sys}\cmd.exe"; Parameters: "/c ""{app}\start-sat-tracker.bat"""; WorkingDir: "{app}"; \
  Description: "Start Pi Sat Track now (opens the browser after 10 s)"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\win-network.ps1"" -Action Uninstall -AppDir ""{app}"""; \
  WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "PstNetwork"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: files; Name: "{app}\*.log"
Type: files; Name: "{app}\Open Pi Sat Track.url"
Type: dirifempty; Name: "{app}"

[Code]
const
  NodeMajorMin = 22;
  NodeVersion = '{#NodeVer}';
  NodeSha256 = '{#NodeSha}';
  NodeMsiName = 'node-v{#NodeVer}-x64.msi';
  NodeUrl = 'https://nodejs.org/dist/v{#NodeVer}/node-v{#NodeVer}-x64.msi';
  OurKey = 'SOFTWARE\Pi Sat Track';
  UninstKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall';
var
  NodeExe: string;
  NeedNode: Boolean;
  DownloadPage: TDownloadWizardPage;
  RemoveData, RemoveNode, NodeWasOurs: Boolean;

function DataDir(): string;
begin
  Result := ExpandConstant('{%USERPROFILE}\.rpitrack');
end;

function NodeMajor(Exe: string): Integer;
var
  Tmp, V: string;
  S: AnsiString;
  Rc, P: Integer;
begin
  Result := 0;
  if (Exe = '') or not FileExists(Exe) then exit;
  Tmp := ExpandConstant('{tmp}\node-version.txt');
  DeleteFile(Tmp);
  if not Exec(ExpandConstant('{cmd}'), '/C ""' + Exe + '" --version > "' + Tmp + '""', '', SW_HIDE, ewWaitUntilTerminated, Rc) then exit;
  if not LoadStringFromFile(Tmp, S) then exit;
  V := Trim(String(S));
  if (Length(V) > 0) and (V[1] = 'v') then Delete(V, 1, 1);
  P := Pos('.', V);
  if P > 0 then V := Copy(V, 1, P - 1);
  Result := StrToIntDef(V, 0);
end;

{ Best Node found: registry InstallPath (64-bit, then 32-bit view), known dir, PATH. }
function FindNode(var Major: Integer): string;
var
  Dir, C: string;
  M: Integer;
  Cands: TArrayOfString;
  I: Integer;
begin
  Result := '';
  Major := 0;
  SetArrayLength(Cands, 4);
  if RegQueryStringValue(HKLM64, 'SOFTWARE\Node.js', 'InstallPath', Dir) then Cands[0] := AddBackslash(Dir) + 'node.exe';
  if RegQueryStringValue(HKLM32, 'SOFTWARE\Node.js', 'InstallPath', Dir) then Cands[1] := AddBackslash(Dir) + 'node.exe';
  Cands[2] := ExpandConstant('{commonpf64}\nodejs\node.exe');
  Cands[3] := FileSearch('node.exe', GetEnv('PATH'));
  for I := 0 to 3 do
  begin
    C := Cands[I];
    Log('Node detect step ' + IntToStr(I) + ' (0=HKLM64 InstallPath, 1=HKLM32 InstallPath, 2=Program Files, 3=PATH): "' + C + '"');
    if (C <> '') and FileExists(C) then
    begin
      M := NodeMajor(C);
      Log('  ' + C + ' reports major version ' + IntToStr(M));
      if M > Major then
      begin
        Major := M;
        Result := C;
      end;
    end;
  end;
end;

function InitializeSetup(): Boolean;
var
  Major: Integer;
begin
  Result := True;
  NodeExe := FindNode(Major);
  NeedNode := Major < NodeMajorMin;
  if NeedNode then
    Log('Node.js ' + IntToStr(Major) + ' found (' + NodeExe + '); will install ' + NodeVersion)
  else
    Log('Node.js ' + IntToStr(Major) + ' found: ' + NodeExe);
end;

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

procedure InitializeWizard();
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), 'Downloading Node.js ' + NodeVersion + ' ...', @OnDownloadProgress);
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := '';
  if MemoDirInfo <> '' then Result := Result + MemoDirInfo + NewLine + NewLine;
  if MemoGroupInfo <> '' then Result := Result + MemoGroupInfo + NewLine + NewLine;
  if MemoTasksInfo <> '' then Result := Result + MemoTasksInfo + NewLine + NewLine;
  if NeedNode then
    Result := Result + 'Prerequisites:' + NewLine + Space +
      'Node.js 22 LTS (will be downloaded and installed: v' + NodeVersion + ' from nodejs.org)' + NewLine;
end;

function InstallNode(var NeedsRestart: Boolean): String;
var
  Msi, LogFile: string;
  Rc, Major: Integer;
begin
  Result := '';
  DownloadPage.Clear;
  DownloadPage.Add(NodeUrl, NodeMsiName, NodeSha256);
  Log('Downloading ' + NodeUrl);
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      Result := 'Could not download Node.js ' + NodeVersion + ' from ' + NodeUrl + ':' + #13#10 +
        GetExceptionMessage + #13#10#13#10 + 'Check the internet connection and run setup again, ' +
        'or install Node.js 22 LTS from https://nodejs.org first.';
      exit;
    end;
  finally
    DownloadPage.Hide;
  end;

  Msi := ExpandConstant('{tmp}\') + NodeMsiName;
  LogFile := ExpandConstant('{%TEMP}\pi-sat-track-node-install.log');
  WizardForm.PreparingLabel.Caption := 'Installing Node.js ' + NodeVersion + ' ...';
  if not Exec(ExpandConstant('{sys}\msiexec.exe'), '/i "' + Msi + '" /qn /norestart /l*v "' + LogFile + '"',
      '', SW_HIDE, ewWaitUntilTerminated, Rc) then
  begin
    Result := 'Could not start msiexec to install Node.js: ' + SysErrorMessage(Rc);
    exit;
  end;
  Log('msiexec Node.js exit code ' + IntToStr(Rc));
  if Rc = 1618 then
  begin
    Result := 'Another installation is in progress (Windows Installer error 1618).' + #13#10 +
      'Wait for it to finish (or restart Windows), then run this setup again.';
    exit;
  end;
  if (Rc <> 0) and (Rc <> 3010) then
  begin
    Result := 'Node.js installation failed (msiexec exit code ' + IntToStr(Rc) + ').' + #13#10 +
      'Log: ' + LogFile + #13#10#13#10 + 'You can install Node.js 22 LTS from https://nodejs.org and run setup again.';
    exit;
  end;
  if Rc = 3010 then NeedsRestart := True;
  Log('Node.js MSI install OK (exit ' + IntToStr(Rc) + ', restart needed: ' + IntToStr(Ord(NeedsRestart)) + ')');

  NodeExe := ExpandConstant('{commonpf64}\nodejs\node.exe');
  Major := NodeMajor(NodeExe);
  if Major < NodeMajorMin then
  begin
    Result := 'Node.js was installed but ' + NodeExe + ' does not report version 22 or newer.' + #13#10 + 'Log: ' + LogFile;
    exit;
  end;
  Log('Node.js after install: ' + NodeExe + ' major ' + IntToStr(Major));
  RegWriteStringValue(HKLM64, OurKey, 'NodeInstalledBySetup', NodeVersion);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Rc: Integer;
  Ps: string;
begin
  Result := '';
  if NeedNode then
  begin
    Result := InstallNode(NeedsRestart);
    if Result <> '' then exit;
  end;
  { Update: stop a running Pi Sat Track server so files can be replaced. }
  Ps := ExpandConstant('{app}\win-network.ps1');
  if FileExists(Ps) then
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -File "' + Ps + '" -Action Stop -AppDir "' + ExpandConstant('{app}') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, Rc);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Rc: Integer;
  App, Npm, LogFile: string;
begin
  if CurStep <> ssPostInstall then exit;
  App := ExpandConstant('{app}');

  { node_modules is bundled by the CI build; npm ci only as a fallback. }
  if not DirExists(App + '\node_modules\serialport') then
  begin
    WizardForm.StatusLabel.Caption := 'Installing Node packages (npm ci --omit=dev) ...';
    Npm := ExtractFilePath(NodeExe) + 'npm.cmd';
    if not FileExists(Npm) then Npm := 'npm';
    LogFile := App + '\npm-install.log';
    if (not Exec(ExpandConstant('{cmd}'),
        '/C ""' + Npm + '" ci --omit=dev --no-audit --no-fund > "' + LogFile + '" 2>&1"',
        App, SW_HIDE, ewWaitUntilTerminated, Rc)) or (Rc <> 0) then
      SuppressibleMsgBox('npm ci failed (code ' + IntToStr(Rc) + '). See ' + LogFile + #13#10 +
        'Check the internet connection, then run setup again (or install-win.bat in ' + App + ').',
        mbError, MB_OK, IDOK);
  end;

  WizardForm.StatusLabel.Caption := 'Setting up port 80 and Windows Firewall rules ...';
  Exec(ExpandConstant('{cmd}'),
    '/C ""' + ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe') +
    '" -NoProfile -ExecutionPolicy Bypass -File "' + App + '\win-network.ps1" -Action Install -AppDir "' + App +
    '" > "' + App + '\network-setup.log" 2>&1"',
    App, SW_HIDE, ewWaitUntilTerminated, Rc);
end;

{ ---------------- Uninstall ---------------- }

function NodeUninstallString(): string;
var
  Names: TArrayOfString;
  I: Integer;
  Dn: string;
begin
  Result := '';
  if not RegGetSubkeyNames(HKLM64, UninstKey, Names) then exit;
  for I := 0 to GetArrayLength(Names) - 1 do
    if RegQueryStringValue(HKLM64, UninstKey + '\' + Names[I], 'DisplayName', Dn) and (Pos('Node.js', Dn) = 1) then
      if (Length(Names[I]) = 38) and (Names[I][1] = '{') then
      begin
        Result := Names[I];
        exit;
      end;
end;

function InitializeUninstall(): Boolean;
var
  Form: TSetupForm;
  Lbl: TNewStaticText;
  Cb, CbNode: TNewCheckBox;
  OkBtn, CancelBtn: TNewButton;
  NodeVerOurs: string;
begin
  Result := True;
  RemoveData := False;
  RemoveNode := False;
  NodeWasOurs := RegQueryStringValue(HKLM64, OurKey, 'NodeInstalledBySetup', NodeVerOurs);
  if UninstallSilent() then exit;
  Form := CreateCustomForm(ScaleX(440), ScaleY(180), False, False);
  try
    Form.ClientWidth := ScaleX(440);
    Form.ClientHeight := ScaleY(180);
    Form.Caption := 'Uninstall Pi Sat Track';
    Form.Position := poScreenCenter;

    Lbl := TNewStaticText.Create(Form);
    Lbl.Parent := Form;
    Lbl.Left := ScaleX(12);
    Lbl.Top := ScaleY(12);
    Lbl.Width := Form.ClientWidth - ScaleX(24);
    Lbl.Height := ScaleY(48);
    Lbl.AutoSize := False;
    Lbl.WordWrap := True;
    Lbl.Caption := 'This stops Pi Sat Track and removes the program, its Start Menu shortcuts, ' +
      'port 80 proxy and firewall rules. Your settings, profiles and logs in ' + DataDir() +
      ' are kept unless you tick the box.';

    Cb := TNewCheckBox.Create(Form);
    Cb.Parent := Form;
    Cb.Left := ScaleX(12);
    Cb.Top := ScaleY(68);
    Cb.Width := Form.ClientWidth - ScaleX(24);
    Cb.Height := ScaleY(20);
    Cb.Caption := 'Remove my settings (' + DataDir() + ')';
    Cb.Checked := False;

    CbNode := TNewCheckBox.Create(Form);
    CbNode.Parent := Form;
    CbNode.Left := ScaleX(12);
    CbNode.Top := ScaleY(94);
    CbNode.Width := Form.ClientWidth - ScaleX(24);
    CbNode.Height := ScaleY(20);
    CbNode.Caption := 'Also uninstall Node.js ' + NodeVerOurs + ' (installed by this setup; other apps may use it)';
    CbNode.Checked := False;
    CbNode.Visible := NodeWasOurs;

    OkBtn := TNewButton.Create(Form);
    OkBtn.Parent := Form;
    OkBtn.Caption := 'Uninstall';
    OkBtn.Width := ScaleX(90);
    OkBtn.Height := ScaleY(26);
    OkBtn.Left := Form.ClientWidth - ScaleX(196);
    OkBtn.Top := Form.ClientHeight - ScaleY(38);
    OkBtn.ModalResult := mrOk;
    OkBtn.Default := True;

    CancelBtn := TNewButton.Create(Form);
    CancelBtn.Parent := Form;
    CancelBtn.Caption := 'Cancel';
    CancelBtn.Width := ScaleX(90);
    CancelBtn.Height := ScaleY(26);
    CancelBtn.Left := Form.ClientWidth - ScaleX(100);
    CancelBtn.Top := Form.ClientHeight - ScaleY(38);
    CancelBtn.ModalResult := mrCancel;
    CancelBtn.Cancel := True;

    Result := Form.ShowModal() = mrOk;
    RemoveData := Cb.Checked;
    RemoveNode := NodeWasOurs and CbNode.Checked;
  finally
    Form.Free();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: string;
  Rc: Integer;
begin
  if CurUninstallStep <> usPostUninstall then exit;
  if RemoveData then
    DelTree(DataDir(), True, True, True);
  if RemoveNode then
  begin
    Code := NodeUninstallString();
    if Code <> '' then
    begin
      Exec(ExpandConstant('{sys}\msiexec.exe'), '/x ' + Code + ' /qn /norestart', '', SW_HIDE, ewWaitUntilTerminated, Rc);
      Log('msiexec /x Node.js exit code ' + IntToStr(Rc));
      if (Rc <> 0) and (Rc <> 3010) then
        MsgBox('Node.js could not be removed (msiexec code ' + IntToStr(Rc) + '). Remove it from Settings > Apps.', mbError, MB_OK);
    end;
  end;
  if RemoveNode or not NodeWasOurs then
    RegDeleteKeyIncludingSubkeys(HKLM64, OurKey);
end;
