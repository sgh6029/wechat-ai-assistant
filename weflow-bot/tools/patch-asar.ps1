param(
    [Parameter(Mandatory = $true)][string]$InAsar,
    [Parameter(Mandatory = $true)][string]$OutAsar,
    [string]$Target = 'dist-electron/main-CYwVc7t8.js'
)

# 纯 PowerShell 版 asar 补丁工具（不需要 node）
# 思路：把改了内容的那个文件"追加"到 payload 末尾，只改它自己的 offset/size，
#      其它文件一个字节都不动（旧数据留在原地当空洞，asar 靠 offset 寻址，没影响）。
# 容器结构（Chromium Pickle）：
#   [u32 4][u32 headerPickleSize] [u32 payloadSize][u32 jsonLen][json][pad] payload...

$ErrorActionPreference = 'Stop'

$BOOT = "`n;try{require(require('path').join(process.resourcesPath,'wfai','hook.js'))}catch(wfaiErr){console.error('[wfai] bootstrap failed',wfaiErr)}`n"
$MARKER = '[wfai] bootstrap'

function U32([byte[]]$b, [int]$at) { return [BitConverter]::ToUInt32($b, $at) }

$buf = [IO.File]::ReadAllBytes($InAsar)
if ($buf.Length -lt 16) { throw '不是合法的 asar（太小）' }
$headerPickleSize = U32 $buf 4
$payloadSize = U32 $buf 8
$jsonLen = U32 $buf 12
$jsonStart = 16
$dataStart = 8 + $headerPickleSize
$aligned = $jsonStart + $jsonLen + ((4 - ($jsonLen % 4)) % 4)
if ($dataStart -ne $aligned) { throw "dataStart 不符：$dataStart vs $aligned" }
if ($dataStart -gt $buf.Length) { throw 'dataStart 越界，文件可能损坏' }
$fileDataSize = $buf.Length - $dataStart   # 文件数据一直延伸到文件末尾

$jsonText = [Text.Encoding]::UTF8.GetString($buf, $jsonStart, $jsonLen)

# ---- 定位目标条目，做"括号配对"截取，避免被 integrity 块干扰
# JSON 是嵌套结构：里面只有文件名这个 key，不带目录
$base = $Target.Split('/')[-1]
$keyIdx = $jsonText.IndexOf('"' + $base + '":{')
if ($keyIdx -lt 0) { $keyIdx = $jsonText.IndexOf('"' + $base + '"') }
if ($keyIdx -lt 0) { throw "asar 里找不到 $Target" }
$braceStart = $jsonText.IndexOf('{', $keyIdx)
if ($braceStart -lt 0) { throw '条目结构异常（找不到 {）' }
$depth = 0
$braceEnd = -1
for ($i = $braceStart; $i -lt $jsonText.Length; $i++) {
    $c = $jsonText[$i]
    if ($c -eq '{') { $depth++ }
    elseif ($c -eq '}') { $depth--; if ($depth -eq 0) { $braceEnd = $i; break } }
}
if ($braceEnd -lt 0) { throw '条目结构异常（括号不配对）' }
$entryText = $jsonText.Substring($braceStart, $braceEnd - $braceStart + 1)

if ($entryText.Contains($MARKER)) { Write-Output 'ALREADY'; exit 2 }
if ($entryText -match '"unpacked"\s*:\s*true') { throw '目标是 unpacked 文件，不支持' }

$mOff = [regex]::Match($entryText, '"offset"\s*:\s*"?(\d+)"?')
$mSize = [regex]::Match($entryText, '"size"\s*:\s*"?(\d+)"?')
if (-not $mOff.Success -or -not $mSize.Success) { throw '条目里找不到 offset/size' }
$oldOffset = [int64]$mOff.Groups[1].Value
$oldSize = [int64]$mSize.Groups[1].Value
$offsetIsString = $entryText.Contains('"offset":"')

# ---- 抠出原文件内容，拼上启动行
$fileStart = $dataStart + $oldOffset
if ($fileStart + $oldSize -gt $buf.Length) { throw '文件偏移越界' }
$oldContent = New-Object byte[] $oldSize
[Array]::Copy($buf, $fileStart, $oldContent, 0, $oldSize)
if ([Text.Encoding]::UTF8.GetString($oldContent).Contains($MARKER)) { Write-Output 'ALREADY'; exit 2 }
$bootBytes = [Text.Encoding]::UTF8.GetBytes($BOOT)
$newContent = New-Object byte[] ($oldSize + $bootBytes.Length)
[Array]::Copy($oldContent, 0, $newContent, 0, $oldSize)
[Array]::Copy($bootBytes, 0, $newContent, $oldSize, $bootBytes.Length)

# ---- 新 payload = 原 payload + 新内容（旧内容留空）
$oldPayload = New-Object byte[] $fileDataSize
[Array]::Copy($buf, $dataStart, $oldPayload, 0, $fileDataSize)
$newOffset = $fileDataSize
$newPayload = New-Object byte[] ($fileDataSize + $newContent.Length)
[Array]::Copy($oldPayload, 0, $newPayload, 0, $fileDataSize)
[Array]::Copy($newContent, 0, $newPayload, $fileDataSize, $newContent.Length)

# ---- 只改这一条的 offset/size（字符串替换，保持 JSON 其它部分字节不变）
$newEntry = $entryText
if ($offsetIsString) {
    $newEntry = [regex]::Replace($newEntry, '"offset"\s*:\s*"?\d+"?', ('"offset":"' + $newOffset + '"'), 1)
} else {
    $newEntry = [regex]::Replace($newEntry, '"offset"\s*:\s*\d+', ('"offset":' + $newOffset), 1)
}
$newEntry = [regex]::Replace($newEntry, '"size"\s*:\s*\d+', ('"size":' + $newContent.Length), 1)
$newJson = $jsonText.Substring(0, $braceStart) + $newEntry + $jsonText.Substring($braceEnd + 1)

# ---- 重新拼容器
$jsonBytes = [Text.Encoding]::UTF8.GetBytes($newJson)
$pad = (4 - ($jsonBytes.Length % 4)) % 4
$newPayloadSize = $jsonBytes.Length + $pad + 4   # JSON 块大小，不含文件数据
$newHeaderPickleSize = $newPayloadSize + 4
$head = New-Object byte[] (8 + $newHeaderPickleSize)
[Array]::Copy([BitConverter]::GetBytes([uint32]4), 0, $head, 0, 4)
[Array]::Copy([BitConverter]::GetBytes([uint32]$newHeaderPickleSize), 0, $head, 4, 4)
[Array]::Copy([BitConverter]::GetBytes([uint32]$newPayloadSize), 0, $head, 8, 4)
[Array]::Copy([BitConverter]::GetBytes([uint32]$jsonBytes.Length), 0, $head, 12, 4)
[Array]::Copy($jsonBytes, 0, $head, 16, $jsonBytes.Length)
# pad 已经是 0

$out = New-Object byte[] ($head.Length + $newPayload.Length)
[Array]::Copy($head, 0, $out, 0, $head.Length)
[Array]::Copy($newPayload, 0, $out, $head.Length, $newPayload.Length)
[IO.File]::WriteAllBytes($OutAsar, $out)

Write-Output ("PATCHED offset={0} size={1} -> {2}  asar {3} -> {4} 字节" -f $oldOffset, $oldSize, $newContent.Length, $buf.Length, $out.Length)
