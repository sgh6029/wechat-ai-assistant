# WeFlow Bot -> 微信投递脚本（重写版）
# 用法: -PayloadFile <utf8 json>
# 载荷: {kind:'text'|'file'|'sticker', contact, text?, file?, send_as?, delay_ms?, exe?, search_down?}
param(
    [Parameter(Mandatory = $true)][string]$PayloadFile
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object Text.UTF8Encoding($false)

function Fail([string]$msg) {
    Write-Output "WFAI_SEND_FAILED: $msg"
    exit 1
}
function Info([string]$msg) { Write-Output "WFAI_INFO: $msg" }

# ------------------------------------------------------------------ 载荷
try {
    $raw = [IO.File]::ReadAllText($PayloadFile, [Text.Encoding]::UTF8)
    $p = $raw | ConvertFrom-Json
} catch {
    Fail "无法读取负载: $($_.Exception.Message)"
}

$kind    = if ($p.kind) { [string]$p.kind } else { 'text' }
$contact = [string]$p.contact
$text    = if ($p.text) { [string]$p.text } else { '' }
$file    = if ($p.file) { [string]$p.file } else { '' }
$sendAs  = if ($p.send_as) { [string]$p.send_as } else { 'image' }
$delay   = if ($p.delay_ms) { [int]$p.delay_ms } else { 350 }
$exeName = if ($p.exe) { [string]$p.exe -replace '\.exe$', '' } else { 'Weixin' }
$down    = if ($null -ne $p.search_down) { [int]$p.search_down } else { 0 }

if (-not $contact) { Fail '缺少联系人' }
if ($kind -eq 'text') {
    if (-not $text) { Fail '缺少消息内容' }
} else {
    if (-not $file) { Fail '缺少文件路径' }
    if (-not (Test-Path -LiteralPath $file)) { Fail "文件不存在: $file" }
}

# ------------------------------------------------------------------ Win32
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class Wfw {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool f);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool fUnknown);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint flags, UIntPtr extra);
    [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(110);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }

    public static List<IntPtr> VisibleOf(int[] pids) {
        var set = new HashSet<int>(pids);
        var list = new List<IntPtr>();
        EnumWindows((h, p) => {
            int pid; GetWindowThreadProcessId(h, out pid);
            if (set.Contains(pid) && IsWindowVisible(h)) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }
    public static string TitleOf(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }
    public static int AreaOf(IntPtr h) {
        RECT r; GetWindowRect(h, out r);
        return (r.Right - r.Left) * (r.Bottom - r.Top);
    }
    public static void AltTap() {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
    }
}
'@

function PidOf([IntPtr]$h) { $q = 0; [Wfw]::GetWindowThreadProcessId($h, [ref]$q) | Out-Null; return $q }

function SafeTitle($h) {
    try {
        if ($null -eq $h) { return '' }
        $i = [IntPtr]$h
        if ($i -eq [IntPtr]::Zero) { return '' }
        return [Wfw]::TitleOf($i)
    } catch { return '' }
}

function WeixinWindows {
    $ids = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    if (-not $ids) { return @() }
    return @([Wfw]::VisibleOf($ids) | Where-Object { $_ -ne [IntPtr]::Zero })
}

function EnsureFg([IntPtr]$h) {
    if ($h -eq [IntPtr]::Zero) { return $false }
    if ([Wfw]::GetForegroundWindow() -eq $h) { return $true }
    if ([Wfw]::IsIconic($h)) { [Wfw]::ShowWindow($h, 9) | Out-Null }
    [Wfw]::BringWindowToTop($h) | Out-Null
    [Wfw]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 250
    if ([Wfw]::GetForegroundWindow() -eq $h) { return $true }

    [Wfw]::AltTap()
    [Wfw]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 250
    if ([Wfw]::GetForegroundWindow() -eq $h) { return $true }

    [Wfw]::SwitchToThisWindow($h, $true)
    Start-Sleep -Milliseconds 300
    if ([Wfw]::GetForegroundWindow() -eq $h) { return $true }

    $cur = [Wfw]::GetForegroundWindow()
    $other = 0
    $wtid = [Wfw]::GetWindowThreadProcessId($cur, [ref]$other)
    $me = [Wfw]::GetCurrentThreadId()
    [Wfw]::AttachThreadInput($me, $wtid, $true) | Out-Null
    [Wfw]::SetForegroundWindow($h) | Out-Null
    [Wfw]::AttachThreadInput($me, $wtid, $false) | Out-Null
    Start-Sleep -Milliseconds 300
    return ([Wfw]::GetForegroundWindow() -eq $h)
}

# 把光标放进消息输入框（微信独立窗口/主窗口的输入栏都在下方中间偏右）
function ClickInput([IntPtr]$h) {
    $r = New-Object Wfw+RECT
    [Wfw]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    if ($w -le 50 -or $ht -le 50) { return $false }
    $x = $r.Left + [int]($w * 0.60)
    $y = $r.Top + [int]($ht * 0.855)
    [void](EnsureFg $h)
    [Wfw]::ClickAt($x, $y)
    Start-Sleep -Milliseconds 250
    Info ("已点击输入框 ({0},{1})" -f $x, $y)
    return $true
}

# ------------------------------------------------------------------ 选窗口
$procs = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Fail "微信未运行（找不到 $exeName 进程）" }
$wxPids = @($procs | ForEach-Object { $_.Id })

$before = @(WeixinWindows)
if ($before.Count -eq 0) { Fail "微信窗口不可见（可能最小化到托盘了）" }

# 1) 已经有这个会话的独立窗口 -> 直接用它（再搜一次就会多开窗口）
$target = $null
foreach ($w in $before) {
    if ((SafeTitle $w) -like "*$contact*") { $target = $w; break }
}
$reused = $false
if ($target -and (EnsureFg $target)) {
    $reused = $true
    Info ("复用已存在的会话窗口 [{0}]" -f (SafeTitle $target))
}

if (-not $reused) {
    # 2) 主窗口（标题「微信」里面积最大的）去搜索
    $main = $before |
        Where-Object { (SafeTitle $_) -eq '微信' } |
        Sort-Object { [Wfw]::AreaOf($_) } -Descending |
        Select-Object -First 1
    if (-not $main) {
        $main = $before |
            Where-Object { (SafeTitle $_) -like '*微信*' } |
            Sort-Object { [Wfw]::AreaOf($_) } -Descending |
            Select-Object -First 1
    }
    if (-not $main) { $main = $before | Sort-Object { [Wfw]::AreaOf($_) } -Descending | Select-Object -First 1 }

    if (-not (EnsureFg $main)) {
        $curPid = PidOf ([Wfw]::GetForegroundWindow())
        $curName = (Get-Process -Id $curPid -ErrorAction SilentlyContinue).ProcessName
        Fail "微信抢不到前台（当前前台是 $curName / pid=$curPid），稍后重试一次即可"
    }
    Info ("在主窗口搜索会话 [{0}]" -f (SafeTitle $main))

    [System.Windows.Forms.Clipboard]::SetText($contact)
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('^f')
    Start-Sleep -Milliseconds $delay
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds ([Math]::Max($delay, 700))
    for ($i = 0; $i -lt $down; $i++) {
        [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')
        Start-Sleep -Milliseconds 180
    }
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds ([Math]::Max($delay, 900))

    # 回车后前台可能被抢走，给两次机会抢回来
    for ($try = 1; $try -le 2; $try++) {
        $fg = [Wfw]::GetForegroundWindow()
        if ($wxPids -contains (PidOf $fg)) { break }
        Info ("回车后前台跑了（pid={0}），第 {1} 次抢回" -f (PidOf $fg), $try)
        [void](EnsureFg $main)
        Start-Sleep -Milliseconds 600
    }

    # 3) 重新选目标：标题匹配 > 新出现的窗口 > 前台微信窗口
    $after = @(WeixinWindows)
    $chosen = $null
    $why = ''
    foreach ($w in $after) {
        if ((SafeTitle $w) -like "*$contact*") { $chosen = $w; $why = '标题匹配'; break }
    }
    if (-not $chosen) {
        foreach ($w in $after) {
            if ($before -notcontains $w) { $chosen = $w; $why = '新开窗口'; break }
        }
    }
    if (-not $chosen) {
        $fg2 = [Wfw]::GetForegroundWindow()
        if ($wxPids -contains (PidOf $fg2)) { $chosen = $fg2; $why = '前台窗口' }
    }
    if (-not $chosen) {
        $curPid = PidOf ([Wfw]::GetForegroundWindow())
        $curName = (Get-Process -Id $curPid -ErrorAction SilentlyContinue).ProcessName
        Fail "搜索回车后找不到微信窗口（前台是 $curName / pid=$curPid，多半落到了「搜索网络结果」），已中止，未发送"
    }
    Info ("目标窗口[{0}] [{1}]" -f $why, (SafeTitle $chosen))
    if (-not (EnsureFg $chosen)) {
        Info "目标窗口抢不到前台，改用当前前台微信窗口"
        $fg3 = [Wfw]::GetForegroundWindow()
        if ($wxPids -contains (PidOf $fg3)) { $chosen = $fg3 } else { Fail '所有微信窗口都抢不到前台，已中止' }
    }
    $target = $chosen
}

# ------------------------------------------------------------------ 投递
if (-not (EnsureFg $target)) {
    $curPid = PidOf ([Wfw]::GetForegroundWindow())
    Fail "发送前微信掉出前台（前台 pid=$curPid），已中止"
}
Start-Sleep -Milliseconds 200

# 关键一步：先把焦点落到输入框，否则粘贴会落空
ClickInput $target | Out-Null

if ($kind -eq 'text') {
    [System.Windows.Forms.Clipboard]::SetText($text)
    Start-Sleep -Milliseconds 160
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 450
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 320
    Write-Output "WFAI_SEND_OK text len=$($text.Length) hwnd=$target"
}
elseif ($kind -eq 'sticker') {
    $asImage = ($sendAs -ne 'file')
    $done = $false
    if ($asImage) {
        try {
            $img = [System.Drawing.Image]::FromFile($file)
            [System.Windows.Forms.Clipboard]::SetImage($img)
            $img.Dispose()
            Start-Sleep -Milliseconds 320
            [System.Windows.Forms.SendKeys]::SendWait('^v')
            Start-Sleep -Milliseconds 1100
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            Start-Sleep -Milliseconds 600
            $done = $true
            Write-Output "WFAI_SEND_OK sticker(image) name=$([IO.Path]::GetFileName($file)) hwnd=$target"
        } catch {
            $done = $false
        }
    }
    if (-not $done) {
        Set-Clipboard -Path $file
        Start-Sleep -Milliseconds 300
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        Start-Sleep -Milliseconds 1200
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        Start-Sleep -Milliseconds 700
        Write-Output "WFAI_SEND_OK sticker(file) name=$([IO.Path]::GetFileName($file)) hwnd=$target"
    }
}
else {
    Set-Clipboard -Path $file
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 1200
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 700
    Write-Output "WFAI_SEND_OK file name=$([IO.Path]::GetFileName($file)) hwnd=$target"
}
exit 0
