param([string]$Out = "")
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$src  = Join-Path $root 'src'
$inst = Join-Path $root 'installer'
$tool = Join-Path $root 'tools'

if (-not $Out) { $Out = Join-Path $root 'build' }
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'payload/tools') | Out-Null

Copy-Item (Join-Path $src 'hook.js')  (Join-Path $Out 'payload') -Force
Copy-Item (Join-Path $src 'ui.js')    (Join-Path $Out 'payload') -Force
Copy-Item (Join-Path $src 'send.ps1') (Join-Path $Out 'payload') -Force
foreach ($d in 'lib', 'plugins') {
    $from = Join-Path $src $d
    if (Test-Path $from) { Copy-Item $from (Join-Path $Out 'payload') -Recurse -Force }
}
foreach ($f in Get-ChildItem $tool -File) {
    Copy-Item $f.FullName (Join-Path $Out 'payload/tools') -Force
}
foreach ($f in Get-ChildItem $inst -File) {
    Copy-Item $f.FullName (Join-Path $Out 'payload') -Force
    Copy-Item $f.FullName $Out -Force
}
Write-Host "已生成: $Out" -ForegroundColor Green
Write-Host "把整个 payload 目录放到 WeFlow\\resources\\wfai，然后运行 install.cmd"
