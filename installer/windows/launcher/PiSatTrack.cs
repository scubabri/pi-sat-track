// Pi Sat Track launcher (Windows GUI). Built by ISCC's preprocessor with the .NET Framework
// csc.exe (installer/windows/pi-sat-track.iss), /target:winexe, pi-sat-track.ico embedded.
//
// A real window (not a console), so the taskbar always shows our icon — also on Windows 11
// where Windows Terminal hosts consoles. It:
//  - finds node.exe (PATH, Program Files\nodejs, HKLM\SOFTWARE\Node.js InstallPath)
//  - runs `node server.js` hidden, stdout / stderr into a read-only log box and
//    %USERPROFILE%\.rpitrack\console.log (the server's own log is .rpitrack\server.log)
//  - opens the browser 10 s after start (then as soon as http://localhost:3000/ answers, max +20 s)
//  - Stop / closing the window ends node and its children (our rigctld) via taskkill /T
// Setup / uninstall / "Stop Pi Sat Track" (win-network.ps1 -Action Stop) end PiSatTrack.exe
// and node by path; with ~/.rpitrack/.stopping present an exit is treated as a deliberate stop.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class PiSatTrackApp
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [STAThread]
    static void Main(string[] args)
    {
        try { SetCurrentProcessExplicitAppUserModelID("PiSatTrack.Server"); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool noBrowser = Array.IndexOf(args, "--no-browser") >= 0;
        Application.Run(new MainForm(!noBrowser));
    }
}

class MainForm : Form
{
    const string Url = "http://localhost:3000/";
    readonly TextBox box = new TextBox();
    readonly Button btnStop = new Button();
    readonly Button btnOpen = new Button();
    readonly Label status = new Label();
    readonly string appDir;
    readonly string homeDir;
    readonly string marker;
    readonly bool openBrowser;
    Process node;
    StreamWriter consoleLog;
    bool closing;
    bool userStopped;
    int lineCount;

    public MainForm(bool openBrowser)
    {
        this.openBrowser = openBrowser;
        appDir = Path.GetDirectoryName(Application.ExecutablePath);
        homeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".rpitrack");
        marker = Path.Combine(homeDir, ".stopping");
        Text = "Pi Sat Track";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        Width = 900; Height = 520;
        StartPosition = FormStartPosition.CenterScreen;

        var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 36, Padding = new Padding(4) };
        btnStop.Text = "Stop"; btnStop.Width = 90; btnStop.Click += (s, e) => { if (node != null && !node.HasExited) StopServer(true); else StartServer(); };
        btnOpen.Text = "Open browser"; btnOpen.Width = 110; btnOpen.Click += (s, e) => OpenUrl();
        status.AutoSize = true; status.Padding = new Padding(8, 6, 0, 0);
        top.Controls.Add(btnStop); top.Controls.Add(btnOpen); top.Controls.Add(status);

        box.Multiline = true; box.ReadOnly = true; box.ScrollBars = ScrollBars.Both; box.WordWrap = false;
        box.Dock = DockStyle.Fill; box.Font = new Font(FontFamily.GenericMonospace, 9f);
        box.BackColor = Color.FromArgb(18, 22, 30); box.ForeColor = Color.FromArgb(220, 225, 235);
        Controls.Add(box); Controls.Add(top);

        Shown += (s, e) => StartServer();
        FormClosing += (s, e) => { closing = true; StopServer(false); };
    }

    void SetStatus(string t) { status.Text = t; }

    void Append(string line)
    {
        if (line == null) return;
        if (InvokeRequired) { try { BeginInvoke(new Action<string>(Append), line); } catch { } return; }
        try { if (consoleLog != null) consoleLog.WriteLine(line); } catch { }
        if (++lineCount > 3000) { box.Clear(); lineCount = 0; }
        box.AppendText(line + Environment.NewLine);
    }

    static string FindNode()
    {
        foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try { var f = Path.Combine(d.Trim().Trim('"'), "node.exe"); if (d.Trim().Length > 0 && File.Exists(f)) return f; } catch { }
        }
        foreach (var pf in new[] { Environment.GetEnvironmentVariable("ProgramW6432"), Environment.GetEnvironmentVariable("ProgramFiles") })
        {
            if (string.IsNullOrEmpty(pf)) continue;
            var f = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(f)) return f;
        }
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using (var b = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                using (var k = b.OpenSubKey(@"SOFTWARE\Node.js"))
                {
                    var p = k == null ? null : k.GetValue("InstallPath") as string;
                    if (!string.IsNullOrEmpty(p) && File.Exists(Path.Combine(p, "node.exe"))) return Path.Combine(p, "node.exe");
                }
            }
            catch { }
        }
        return null;
    }

    void StartServer()
    {
        userStopped = false;
        try { Directory.CreateDirectory(homeDir); if (File.Exists(marker)) File.Delete(marker); } catch { }
        try { consoleLog = new StreamWriter(Path.Combine(homeDir, "console.log"), false, new UTF8Encoding(false)) { AutoFlush = true }; } catch { consoleLog = null; }
        string exe = FindNode();
        if (exe == null)
        {
            Append("Node.js was not found. Install Node.js 22 or newer from https://nodejs.org");
            SetStatus("Node.js not found"); btnStop.Text = "Start";
            return;
        }
        var psi = new ProcessStartInfo(exe, "server.js")
        {
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        // node found outside PATH: put its folder first (npm etc. for child processes)
        psi.EnvironmentVariables["PATH"] = Path.GetDirectoryName(exe) + ";" + (Environment.GetEnvironmentVariable("PATH") ?? "");
        try
        {
            node = new Process { StartInfo = psi, EnableRaisingEvents = true };
            node.OutputDataReceived += (s, e) => Append(e.Data);
            node.ErrorDataReceived += (s, e) => Append(e.Data);
            node.Exited += (s, e) => { try { BeginInvoke(new Action(OnExited)); } catch { } };
            node.Start();
            node.BeginOutputReadLine();
            node.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            Append("Could not start node: " + ex.Message);
            SetStatus("not running"); btnStop.Text = "Start";
            return;
        }
        Append("Pi Sat Track - " + exe + " server.js (pid " + node.Id + ") - open " + Url);
        SetStatus("running - " + Url);
        btnStop.Text = "Stop";
        if (openBrowser) new Thread(OpenWhenReady) { IsBackground = true }.Start();
    }

    void OnExited()
    {
        int code = 0;
        try { code = node.ExitCode; } catch { }
        bool deliberate = userStopped || closing || File.Exists(marker);
        if (!userStopped && File.Exists(marker)) { try { File.Delete(marker); } catch { } Close(); return; } // setup / Stop shortcut
        Append(deliberate ? "Server stopped." : "Server exited with code " + code + " - see the lines above (log: " + Path.Combine(homeDir, "server.log") + ")");
        SetStatus(deliberate ? "stopped" : "exited (code " + code + ")");
        btnStop.Text = "Start";
        try { if (consoleLog != null) consoleLog.Dispose(); } catch { }
        consoleLog = null;
    }

    void StopServer(bool byUser)
    {
        userStopped = byUser || userStopped;
        var p = node;
        if (p == null) return;
        try
        {
            if (!p.HasExited)
            {
                // node and its children (our rigctld)
                var k = Process.Start(new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false });
                if (k != null) k.WaitForExit(5000);
                if (!p.HasExited) p.Kill();
                p.WaitForExit(5000);
            }
        }
        catch { }
    }

    void OpenWhenReady()
    {
        Thread.Sleep(10000);
        var deadline = DateTime.Now.AddSeconds(20);
        while (DateTime.Now < deadline && !closing)
        {
            try
            {
                var rq = (HttpWebRequest)WebRequest.Create(Url);
                rq.Timeout = 2000;
                using (rq.GetResponse()) { }
                break;
            }
            catch (WebException we) { if (we.Response != null) break; Thread.Sleep(500); }
            catch { Thread.Sleep(500); }
        }
        if (!closing && node != null && !node.HasExited) OpenUrl();
    }

    static void OpenUrl()
    {
        try { Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); } catch { }
    }
}
