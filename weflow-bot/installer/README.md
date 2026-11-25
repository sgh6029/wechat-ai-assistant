# 安装器源码说明

`Setup-Program.cs` 是单文件安装器 EXE 的源码（C#）：
把 `payload.zip` 作为嵌入资源编译进去，运行时解压到临时目录并调用 `install.ps1`。

编译（不需要装额外工具，Windows 自带 .NET Framework 编译器）：

```powershell
# 1. 先组装 payload
.\build-payload.ps1

# 2. 打包成 zip
Compress-Archive -Path build\payload\* -DestinationPath build\payload.zip -Force

# 3. 编译
$csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:exe /platform:anycpu /optimize+ `
  /out:WeFlow-Bot-Setup.exe `
  /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
  "/resource:build\payload.zip,payload.zip" installer\Setup-Program.cs
```

> 无签名的 exe 在 Windows 上容易被 SmartScreen/杀软拦掉（双击没反应）。
> 更推荐直接用 zip 解压 + `install.cmd`。
