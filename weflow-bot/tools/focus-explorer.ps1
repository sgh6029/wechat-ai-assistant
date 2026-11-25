param([string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WfFg {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool f);
    [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);
    [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    public static IntPtr Find(string titlePart) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) => {
            if (!IsWindowVisible(h)) return true;
            var cls = new StringBuilder(128); GetClassName(h, cls, 128);
            if (cls.ToString() != "CabinetWClass") return true;
            var sb = new StringBuilder(400); GetWindowText(h, sb, 400);
            if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool Focus(IntPtr h) {
        if (h == IntPtr.Zero) return false;
        if (IsIconic(h)) ShowWindow(h, 9);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(200);
        if (GetForegroundWindow() == h) return true;
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(200);
        if (GetForegroundWindow() == h) return true;
        var cur = GetForegroundWindow();
        int pid = 0;
        int tid = GetWindowThreadProcessId(cur, out pid);
        int me = GetCurrentThreadId();
        AttachThreadInput(me, tid, true);
        SetForegroundWindow(h);
        AttachThreadInput(me, tid, false);
        System.Threading.Thread.Sleep(200);
        return GetForegroundWindow() == h;
    }
}
'@
# Explorer 建窗口要一点时间，重试几轮
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 500
    $h = [WfFg]::Find($Title)
    if ($h -eq [IntPtr]::Zero) { continue }
    $ok = [WfFg]::Focus($h)
    if ($ok) { Write-Output ("FOCUSED {0} {1}" -f $ok, $h); exit 0 }
    # 再补一手 SwitchToThisWindow
    try { [WfFg]::SwitchTo($h); if ([WfFg]::GetForegroundWindow() -eq $h) { Write-Output "FOCUSED2 $h"; exit 0 } } catch {}
}
Write-Output "GIVEUP $Title"
