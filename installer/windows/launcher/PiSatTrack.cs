// Pi Sat Track launcher (Windows). Built by ISCC's preprocessor with the .NET Framework
// csc.exe (installer/windows/pi-sat-track.iss), with pi-sat-track.ico embedded.
//
// Why: a console started from start-sat-tracker.bat shows cmd's icon on the taskbar.
// This exe owns the console window instead, so the taskbar shows our icon:
//  - SetCurrentProcessExplicitAppUserModelID("PiSatTrack.Server") (= the Start shortcut's)
//  - console title "Pi Sat Track", WM_SETICON with the embedded icon on GetConsoleWindow()
// then runs start-sat-tracker.bat (Node lookup, browser opener, .stopping marker) in the
// same console and exits with its exit code. Ctrl+C is left to node / the .bat.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;

static class PiSatTrack
{
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    const int WM_SETICON = 0x0080;

    static int Main(string[] args)
    {
        try { SetCurrentProcessExplicitAppUserModelID("PiSatTrack.Server"); } catch { }
        try { Console.Title = "Pi Sat Track"; } catch { }
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        string dir = Path.GetDirectoryName(exe);
        try
        {
            IntPtr hwnd = GetConsoleWindow();
            if (hwnd != IntPtr.Zero)
            {
                string icoPath = Path.Combine(dir, "pi-sat-track.ico");
                Icon big = File.Exists(icoPath) ? new Icon(icoPath, 32, 32) : Icon.ExtractAssociatedIcon(exe);
                Icon small = File.Exists(icoPath) ? new Icon(icoPath, 16, 16) : big;
                SendMessage(hwnd, WM_SETICON, (IntPtr)1, big.Handle);   // ICON_BIG
                SendMessage(hwnd, WM_SETICON, (IntPtr)0, small.Handle); // ICON_SMALL
            }
        }
        catch { }

        // Ctrl+C / Ctrl+Break: let the server (child) handle it; we just wait for it.
        Console.CancelKeyPress += (s, e) => { e.Cancel = true; };

        string bat = Path.Combine(dir, "start-sat-tracker.bat");
        string cmd = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        var psi = new ProcessStartInfo(cmd, "/c \"\"" + bat + "\" " + string.Join(" ", args) + "\"");
        psi.UseShellExecute = false; // same console window
        psi.WorkingDirectory = dir;
        try
        {
            using (var p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Could not start " + bat + ": " + ex.Message);
            Console.WriteLine("Press Enter to close.");
            Console.ReadLine();
            return 1;
        }
    }
}
