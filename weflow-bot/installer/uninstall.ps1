param([string]$WeFlowDir = '')
$ErrorActionPreference = 'Stop'

function Find-WeFlow {
    if ($WeFlowDir) { return $WeFlowDir }
    $c = @()
    foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
                     'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        try {
            Get-ItemProperty $k -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like '*WeFlow*' -and $_.InstallLocation } |
                ForEach-Object { $c += $_.InstallLocation }
        } catch {}
    }
    $c += @("$env:LOCALAPPDATA\Programs\WeFlow", "$env:LOCALAPPDATA\WeFlow", "$env:ProgramFiles\WeFlow",
            "${env:ProgramFiles(x86)}\WeFlow", 'D:\deepseek\WX\WeFlow', 'C:\WeFlow')
    try {
        $r = Get-Process -Name WeFlow -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($r -and $r.Path) { $c = @((Split-Path -Parent $r.Path)) + $c }
    } catch {}
    foreach ($x in $c) { if ($x -and (Test-Path -LiteralPath (Join-Path $x 'resources\app.asar'))) { return $x } }
    return $null
}

$wf = Find-WeFlow
if (-not $wf) {
    Write-Host '没自动找到 WeFlow，请输入安装目录：' -ForegroundColor Yellow
    $wf = (Read-Host '目录').Trim('"').Trim()
}
Write-Host "WeFlow 目录: $wf" -ForegroundColor Cyan
Get-Process -Name WeFlow -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 900

$wfai = Join-Path $wf 'resources\wfai'
if (Test-Path -LiteralPath $wfai) { Remove-Item -LiteralPath $wfai -Recurse -Force; Write-Host '已删除 resources\wfai' -ForegroundColor Green }

$bak = Join-Path $wf 'resources\app.asar.before-wfai'
$asar = Join-Path $wf 'resources\app.asar'
if (Test-Path -LiteralPath $bak) {
    Copy-Item -LiteralPath $bak -Destination $asar -Force
    Write-Host '已把 app.asar 还原成安装前的样子' -ForegroundColor Green
} else {
    Write-Host '没找到 app.asar.before-wfai，asar 保持不动' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '配置目录 %APPDATA%\weflow\wfai 保留着（里面是你的设置和归档），要彻底清除请手动删除。' -ForegroundColor Yellow
Read-Host '按回车退出' | Out-Null