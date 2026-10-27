; Pi Sat Track - Windows setup.exe (Inno Setup 6)
; Build (see .github/workflows/build-win-setup.yml):
;   ISCC /DAppLabel=<branch>-alpha.<N> /O<outdir> /Fpi-sat-track-<branch>-alpha.<N>-setup pi-sat-track.iss
; install-win.bat / uninstall-win.bat remain the no-setup fallback.
;
; Installs to C:\Program Files\Pi Sat Track. Settings stay in %USERPROFILE%\.rpitrack.
; Needs Node.js 22+ (not bundled, not downloaded). Runs npm ci --omit=dev, then
; win-network.ps1 -Action Install (port 80 proxy + firewall rules TCP 80/3000).
; No service, no auto start: Start Menu shortcuts start / stop / open it.

#ifndef AppLabel
  #define AppLabel "dev"
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
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputBaseFilename=pi-sat-track-{#AppLabel}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={sys}\shell32.dll,13
VersionInfoVersion=0.1.0.0
VersionInfoTextVersion={#AppLabel}
CloseApplications=no

[Files]
Source: "{#SrcRoot}\*"; DestDir: "{app}"; \
  Excludes: "\.git,\.github,\.gitattributes,\.gitignore,\node_modules,\dist,\installer,\test,\tools,\*.run,\*.sh,\*.log"; \
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
Filename: "{app}\start-sat-tracker.bat"; WorkingDir: "{app}"; Description: "Start Pi Sat Track now"; \
  Flags: postinstall nowait skipifsilent shellexec runasoriginaluser
Filename: "{app}\Open Pi Sat Track.url"; Description: "Open Pi Sat Track in the browser"; \
  Flags: postinstall nowait skipifsilent shellexec runasoriginaluser unchecked

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
  NodeUrl = 'https://nodejs.org/en/download';
var
  NodeExe: string;
  RemoveData: Boolean;

function DataDir(): string;
begin
  Result := ExpandConstant('{%USERPROFILE}\.rpitrack');
end;

function FindNode(): string;
begin
  Result := ExpandConstant('{commonpf64}\nodejs\node.exe');
  if FileExists(Result) then exit;
  Result := FileSearch('node.exe', GetEnv('PATH'));
end;

function NodeMajor(Exe: string): Integer;
var
  Tmp: string;
  S: AnsiString;
  V: string;
  Rc, P: Integer;
begin
  Result := 0;
  Tmp := ExpandConstant('{tmp}\node-version.txt');
  if not Exec(ExpandConstant('{cmd}'), '/C ""' + Exe + '" -v > "' + Tmp + '""', '', SW_HIDE, ewWaitUntilTerminated, Rc) then exit;
  if not LoadStringFromFile(Tmp, S) then exit;
  V := Trim(String(S));
  if (Length(V) > 0) and (V[1] = 'v') then Delete(V, 1, 1);
  P := Pos('.', V);
  if P > 0 then V := Copy(V, 1, P - 1);
  Result := StrToIntDef(V, 0);
end;

function InitializeSetup(): Boolean;
var
  Major, Ec: Integer;
  Msg: string;
begin
  Result := True;
  NodeExe := FindNode();
  Major := 0;
  if NodeExe <> '' then Major := NodeMajor(NodeExe);
  if Major >= NodeMajorMin then exit;
  if NodeExe = '' then
    Msg := 'Node.js was not found.'
  else
    Msg := 'Node.js ' + IntToStr(Major) + ' was found (' + NodeExe + ').';
  Msg := Msg + #13#10#13#10 + 'Pi Sat Track needs Node.js ' + IntToStr(NodeMajorMin) +
    ' or newer. Install the LTS version from ' + NodeUrl +
    ', then run this setup again.' + #13#10#13#10 + 'Open the Node.js download page now?';
  if SuppressibleMsgBox(Msg, mbError, MB_YESNO, IDNO) = IDYES then
    ShellExec('open', NodeUrl, '', '', SW_SHOWNORMAL, ewNoWait, Ec);
  Result := False;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Rc: Integer;
  Ps: string;
begin
  Result := '';
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
  App, Npm, Log: string;
begin
  if CurStep <> ssPostInstall then exit;
  App := ExpandConstant('{app}');

  WizardForm.StatusLabel.Caption := 'Installing Node packages (npm ci --omit=dev) ...';
  Npm := ExtractFilePath(NodeExe) + 'npm.cmd';
  if not FileExists(Npm) then Npm := 'npm';
  Log := App + '\npm-install.log';
  if (not Exec(ExpandConstant('{cmd}'),
      '/C ""' + Npm + '" ci --omit=dev --no-audit --no-fund > "' + Log + '" 2>&1"',
      App, SW_HIDE, ewWaitUntilTerminated, Rc)) or (Rc <> 0) then
    SuppressibleMsgBox('npm ci failed (code ' + IntToStr(Rc) + '). See ' + Log + #13#10 +
      'Check the internet connection, then run setup again (or install-win.bat in ' + App + ').',
      mbError, MB_OK, IDOK);

  WizardForm.StatusLabel.Caption := 'Setting up port 80 and Windows Firewall rules ...';
  Exec(ExpandConstant('{cmd}'),
    '/C ""' + ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe') +
    '" -NoProfile -ExecutionPolicy Bypass -File "' + App + '\win-network.ps1" -Action Install -AppDir "' + App +
    '" > "' + App + '\network-setup.log" 2>&1"',
    App, SW_HIDE, ewWaitUntilTerminated, Rc);
end;

function InitializeUninstall(): Boolean;
var
  Form: TSetupForm;
  Lbl: TNewStaticText;
  Cb: TNewCheckBox;
  OkBtn, CancelBtn: TNewButton;
begin
  Result := True;
  RemoveData := False;
  if UninstallSilent() then exit;
  Form := CreateCustomForm();
  try
    Form.ClientWidth := ScaleX(420);
    Form.ClientHeight := ScaleY(150);
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
    Cb.Top := ScaleY(70);
    Cb.Width := Form.ClientWidth - ScaleX(24);
    Cb.Height := ScaleY(20);
    Cb.Caption := 'Remove my settings (' + DataDir() + ')';
    Cb.Checked := False;

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
  finally
    Form.Free();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and RemoveData then
    DelTree(DataDir(), True, True, True);
end;
