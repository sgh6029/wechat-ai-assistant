param(
    [string]$WeFlowDir = '',
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'payload'

# EXE 解压出来是平铺的：hook.js 和脚本在同一层
if (-not (Test-Path -LiteralPath (Join-Path $src 'hook.js'))) {
    if (Test-Path -LiteralPath (Join-Path $here 'hook.js')) { $src = $here }
}

if (-not (Test-Path -LiteralPath (Join-Path $src 'hook.js'))) {
    $zip = Join-Path $here 'payload.zip'
    if (Test-Path -LiteralPath $zip) {
        $tmp = Join-Path $env:TEMP ("wfai-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
        $src = $tmp
    }
}

function Say($m, $color = 'Cyan') { if (-not $Quiet) { Write-Host $m -ForegroundColor $color } }
function Die($m) { Write-Host "X $m" -ForegroundColor Red; exit 1 }

Say ''
Say '=============================================='
Say '   WeFlow 微信 AI 助手（Bot）安装程序'
Say '=============================================='
Say ''

if (-not (Test-Path -LiteralPath (Join-Path $src 'hook.js'))) { Die '安装包不完整：找不到 hook.js' }

function Find-WeFlow {
    if ($WeFlowDir) {
        if (Test-Path -LiteralPath (Join-Path $WeFlowDir 'resources\app.asar')) { return $WeFlowDir }
        Die "指定的目录里没有 resources\app.asar：$WeFlowDir"
    }
    $cands = @()
    foreach ($k in @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )) {
        try {
            Get-ItemProperty $k -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like '*WeFlow*' -and $_.InstallLocation } |
                ForEach-Object { $cands += $_.InstallLocation }
        } catch {}
    }
    $cands += @(
        "$env:LOCALAPPDATA\Programs\WeFlow",
        "$env:LOCALAPPDATA\WeFlow",
        "$env:ProgramFiles\WeFlow",
        "${env:ProgramFiles(x86)}\WeFlow",
        'D:\deepseek\WX\WeFlow',
        'C:\WeFlow',
        "$env:USERPROFILE\Desktop\WeFlow",
        "$env:USERPROFILE\Downloads\WeFlow"
    )
    try {
        $running = Get-Process -Name WeFlow -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($running -and $running.Path) { $cands = @((Split-Path -Parent $running.Path)) + $cands }
    } catch {}
    foreach ($c in $cands) {
        if (-not $c) { continue }
        try { if (Test-Path -LiteralPath (Join-Path $c 'resources\app.asar')) { return $c } } catch {}
    }
    return $null
}

$wf = Find-WeFlow
if (-not $wf) {
    Say ''
    Say '没有自动找到 WeFlow 安装目录。' 'Yellow'
    Say '请把 WeFlow 的安装目录（里面有 resources\app.asar 的那一层）粘贴进来，然后回车：'
    $wf = (Read-Host 'WeFlow 目录').Trim('"').Trim()
    if (-not (Test-Path -LiteralPath (Join-Path $wf 'resources\app.asar'))) { Die '这个目录里没有 resources\app.asar' }
}
Say "  WeFlow 目录：$wf" 'Green'

$asar = Join-Path $wf 'resources\app.asar'
$wfaiDir = Join-Path $wf 'resources\wfai'
$exe = Join-Path $wf 'WeFlow.exe'
if (-not (Test-Path -LiteralPath $exe)) { Die '找不到 WeFlow.exe' }

# 用纯 PowerShell 打补丁（不依赖 node）
$patchPs = Join-Path $src 'tools\patch-asar.ps1'
function Invoke-AsarPatch([string]$inAsar, [string]$outAsar) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $patchPs -InAsar $inAsar -OutAsar $outAsar 2>&1
        $code = $LASTEXITCODE
        return @{ code = $code; ok = ($code -eq 0); already = ($code -eq 2); out = ($out -join "`n") }
    } finally { $ErrorActionPreference = $prev }
}

Say ''
Say '> 关闭 WeFlow（打补丁时不能运行）'
Get-Process -Name WeFlow -ErrorAction SilentlyContinue | Stop-Process -Force
for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-Process -Name WeFlow -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
}
if (Get-Process -Name WeFlow -ErrorAction SilentlyContinue) { Die 'WeFlow 无法退出，请手动关掉再运行' }
Say '  已关闭' 'Green'

Say ''
Say '> 检查 / 修补 app.asar'
$bakAsar = Join-Path $wf 'resources\app.asar.before-wfai'
if (-not (Test-Path -LiteralPath $bakAsar)) {
    Copy-Item -LiteralPath $asar -Destination $bakAsar -Force
    Say '  已备份原 asar 到 app.asar.before-wfai'
}
$tmp = Join-Path $wf 'resources\app.asar.new'
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
$p = Invoke-AsarPatch $asar $tmp
if ($p.already) {
    Say '  已经是打好补丁的状态，跳过' 'Green'
} elseif (-not $p.ok -or -not (Test-Path -LiteralPath $tmp)) {
    Die "打补丁失败：$($p.out)"
} else {
    if ((Get-Item $tmp).Length -lt 1MB) { Die '补丁产物异常（太小），已中止' }
    Copy-Item -LiteralPath $tmp -Destination $asar -Force
    Remove-Item -LiteralPath $tmp -Force
    Say ("  已打好补丁：" + ($p.out -split "`n" | Select-Object -First 1)) 'Green'
}

Say ''
Say '> 部署 Bot 文件到 resources\wfai'
if (Test-Path -LiteralPath $wfaiDir) {
    $bakDir = Join-Path $wf ("resources\wfai.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try { Move-Item -LiteralPath $wfaiDir -Destination $bakDir -Force } catch {}
}
New-Item -ItemType Directory -Force -Path $wfaiDir | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $src) {
    if ($item.Name -in @('tools', 'lib', 'plugins')) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $wfaiDir $item.Name) -Force -Recurse
}
foreach ($sub in @('lib', 'plugins', 'tools')) {
    $from = Join-Path $src $sub
    if (Test-Path -LiteralPath $from) {
        $to = Join-Path $wfaiDir $sub
        if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
        Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
    }
}
Say '  已复制' 'Green'

$cfgDir = Join-Path $env:APPDATA 'weflow\wfai'
$cfgFile = Join-Path $cfgDir 'config.json'
if (-not (Test-Path -LiteralPath $cfgFile)) {
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    Say ''
    Say '> 首次安装，生成配置模板'
    $weflowCfg = Join-Path $env:APPDATA 'weflow\WeFlow-config.json'
    $wPort = 5031
    $wTok = ''
    if (Test-Path -LiteralPath $weflowCfg) {
        try {
            $j = Get-Content -LiteralPath $weflowCfg -Raw | ConvertFrom-Json
            if ($j.httpApiPort) { $wPort = [int]$j.httpApiPort }
            if ($j.httpApiToken -and "$($j.httpApiToken)" -notlike 'safe:*') { $wTok = "$($j.httpApiToken)" }
        } catch {}
    }
    $cfg = @{}
    $cfg.listen = $true
    $cfg.auto_reply = $false
    $cfg.dry_run = $true
    $cfg.buffer_seconds = 10
    $cfg.max_history = 6
    $cfg.max_reply_chars = 120
    $cfg.system_prompt = '你是微信聊天助手。请用简短、自然、口语化的中文回复对方，不要使用书面语，不要加表情符号，不超过 50 字。'
    $cfg.weflow = @{ base_url = "http://127.0.0.1:$wPort"; access_token = $wTok }
    $cfg.ai = @{
        provider = 'deepseek'
        type = 'openai'
        base_url = 'https://api.deepseek.com'
        api_key = ''
        model = 'deepseek-flash'
        timeout = 40
        native_search = $true
        native_read_url = $true
        search_strategy = 'agent'
        search_priority = 'native'
        thinking = 'auto'
        reasoning_effort = ''
        ollama_url = 'http://127.0.0.1:11434/api/generate'
        ollama_model = 'qwen3:8b'
    }
    $cfg.send = @{ enabled = $false; delay_ms = 350; search_down = 0; wechat_exe = 'Weixin.exe' }
    $cfg.filter = @{ drop_self = $true; drop_other_emoji = $true; emoji_mode = 'pure'; mode = 'off'; list = @(); sync_weflow = $true }
    $cfg.reply = @{ strip_emoji = $true; at_person = $true; tidy_punct = $true; max_chars_group = 160 }
    $cfg.mention = @{ enabled = $true; action = 'ai'; cooldown_seconds = 0; poke_enabled = $true; aliases = @(); respect_filter = $false; context_count = 5 }
    $cfg.context = @{ enabled = $true; max_tokens = 200000; compress_at = 0.75; keep_recent = 20; summary_max_chars = 700; archive_compressed = $true }
    $cfg.schedule = @{ enabled = $true; tick_seconds = 30; rules = @() }
    $cfg.sticker = @{ enabled = $false; dir = ''; pick = 'tagged'; send_as = 'auto' }
    $cfg.web = @{ enabled = $true; search_url = 'https://cn.bing.com/search?q={q}'; max_results = 6 }
    $cfg.archive = @{ enabled = $true; interval_minutes = 30; scope = 'all'; limit_per_session = 200 }
    $json = $cfg | ConvertTo-Json -Depth 8
    # 必须写不带 BOM 的 UTF-8，否则 JSON.parse 会因 BOM 失败（之前踩过）
    [IO.File]::WriteAllText($cfgFile, $json, (New-Object Text.UTF8Encoding($false)))
    Say "  已生成 $cfgFile" 'Green'
    Say '  注意：里面的 API Key 是空的，装好后在面板里填。' 'Yellow'
} else {
    Say ''
    Say '  检测到已有配置，保留不动（不会覆盖你的设置）' 'Green'
}

Say ''
Say '=============================================='
Say '  安装完成' 'Green'
Say '=============================================='
Say '  接下来：'
Say '   1. 启动 WeFlow'
Say '   2. 左侧边栏会出现「Bot」，点进去'
Say '   3. 设置页填 API Key 并保存'
Say '   4. 先保持「干跑」试几条，确认窗口和联系人都对'
Say '   5. 再把「干跑」关掉、「允许键盘发送」打开'
Say ''
Say '  卸载：删掉 resources\wfai，再把 resources\app.asar.before-wfai 覆盖回 app.asar'
Say ''
if (-not $Quiet) { Read-Host '按回车退出' | Out-Null }
