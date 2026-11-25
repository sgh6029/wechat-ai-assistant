using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

// WeFlow 微信 AI 助手（Bot）安装器
// 自带 payload.zip 作为嵌入资源，双击后解压到临时目录并运行 install.ps1
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Console.Title = "WeFlow 微信 AI 助手 - 安装程序";
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;

        string work = Path.Combine(Path.GetTempPath(), "wfai-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        try
        {
            Console.WriteLine();
            Console.WriteLine("==============================================");
            Console.WriteLine("   WeFlow 微信 AI 助手（Bot）安装程序");
            Console.WriteLine("==============================================");
            Console.WriteLine();
            Console.WriteLine("  正在解压安装文件…");

            Directory.CreateDirectory(work);
            var asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("payload.zip"))
            {
                if (s == null)
                {
                    Console.WriteLine("  [错误] 安装包内缺少 payload.zip，文件可能损坏。");
                    Pause();
                    return 1;
                }
                using (var f = File.Create(Path.Combine(work, "payload.zip")))
                {
                    s.CopyTo(f);
                }
            }

            string payload = Path.Combine(work, "payload");
            ZipFile.ExtractToDirectory(Path.Combine(work, "payload.zip"), payload);

            string ps1 = Path.Combine(payload, "install.ps1");
            if (!File.Exists(ps1))
            {
                Console.WriteLine("  [错误] 解压后找不到 install.ps1");
                Pause();
                return 1;
            }

            Console.WriteLine("  解压完成，开始安装…");
            Console.WriteLine();

            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + ps1 + "\"",
                UseShellExecute = false,
            };
            if (args != null && args.Length > 0)
            {
                var extra = new StringBuilder(psi.Arguments);
                foreach (string a in args)
                {
                    extra.Append(" ").Append(a);
                }
                psi.Arguments = extra.ToString();
            }

            using (var p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine();
            Console.WriteLine("  [错误] " + ex.Message);
            Console.WriteLine(ex.StackTrace);
            Pause();
            return 1;
        }
        finally
        {
            try
            {
                if (Directory.Exists(work))
                {
                    Directory.Delete(work, true);
                }
            }
            catch { }
        }
    }

    private static void Pause()
    {
        Console.WriteLine();
        Console.Write("按回车退出…");
        try { Console.ReadLine(); } catch { }
    }
}
