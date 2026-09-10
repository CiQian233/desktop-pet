// 7za.exe shim source -- compiled and installed by scripts/build-7za-shim.ps1.
//
// electron-builder extracts the winCodeSign helper with `7za x`, but that
// archive contains two macOS symlinks (libcrypto.dylib / libssl.dylib) which
// Windows refuses to create without elevation; 7za then exits 2 and the build
// fails even though the only file actually needed (rcedit-x64.exe) extracted
// fine.
//
// This shim compiles to a real 7za.exe that strips those two entries into a
// scratch copy first and then delegates to the genuine binary, which lives
// beside it as 7za-real.exe. It must be a compiled exe (not a .cmd) because
// electron-builder invokes the full path directly, which Windows will not
// resolve to a .cmd.
//
// Targets .NET Framework 4.0: no ArgumentList, so quoting is done by hand.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

class SevenZipShim
{
    static readonly string[] Symlinks = new string[]
    {
        "darwin/10.12/lib/libcrypto.dylib",
        "darwin/10.12/lib/libssl.dylib",
    };

    /// set PET_7ZA_DEBUG=<file> to trace what the shim decided to do
    static readonly string LogFile = Environment.GetEnvironmentVariable("PET_7ZA_DEBUG");

    static void Trace(string message)
    {
        if (string.IsNullOrEmpty(LogFile)) return;
        try
        {
            File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
        }
        catch { }
    }

    static int Main(string[] args)
    {
        string selfDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string real = Path.Combine(selfDir, "7za-real.exe");
        if (!File.Exists(real))
        {
            Console.Error.WriteLine("7za shim: missing " + real);
            return 1;
        }
        Trace("args: " + string.Join(" | ", args));

        // 7za lets switches sit anywhere relative to the command and archive
        // (`x -snld -bd a.7z -oDIR` and `x a.7z -oDIR` are both valid), so find
        // the archive by shape instead of by position.
        string cmd = null;
        string archive = null;
        string[] knownCommands = new string[] { "x", "e", "l", "d", "a", "t", "u", "b", "i", "h", "rn" };
        foreach (string a in args)
        {
            if (a.StartsWith("-") || a.StartsWith("@")) continue;
            if (cmd == null && Array.IndexOf(knownCommands, a) >= 0)
            {
                cmd = a;
                continue;
            }
            if (archive == null
                && a.EndsWith(".7z", StringComparison.OrdinalIgnoreCase)
                && File.Exists(a))
            {
                archive = a;
            }
        }

        bool isExtract = (cmd == "x" || cmd == "e")
            && archive != null
            && archive.EndsWith(".7z", StringComparison.OrdinalIgnoreCase)
            && File.Exists(archive);
        Trace("cmd=" + cmd + " archive=" + archive + " isExtract=" + isExtract
            + " argc=" + args.Length);

        if (!isExtract) return Run(real, args, null, null);

        string scratch = Path.Combine(Path.GetTempPath(), "pet7za-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        try
        {
            string cleaned = Path.Combine(scratch, "cleaned.7z");
            File.Copy(archive, cleaned, true);

            // best effort: if the entries are already absent the delete fails
            var del = new string[Symlinks.Length + 4];
            del[0] = "d";
            del[1] = cleaned;
            Array.Copy(Symlinks, 0, del, 2, Symlinks.Length);
            del[del.Length - 2] = "-r";
            del[del.Length - 1] = "-y";
            int delCode = Run(real, del, null, null);
            Trace("delete exit=" + delCode + " cleaned=" + cleaned);

            // if the strip did not take, fall through to the untouched archive
            bool stripped = delCode == 0;
            if (stripped && ListContains(real, cleaned, "libcrypto.dylib"))
            {
                Trace("archive still lists the symlink; falling back to the original");
                stripped = false;
            }

            int code = Run(real, args, archive, stripped ? cleaned : null);
            Trace("extract exit=" + code + " usedCleaned=" + stripped);
            return code;
        }
        finally
        {
            try { Directory.Delete(scratch, true); } catch { }
        }
    }

    /// true when `7za l <archive>` output mentions the given name
    static bool ListContains(string real, string archive, string needle)
    {
        try
        {
            var psi = new ProcessStartInfo(real);
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.Arguments = Quote("l") + " " + Quote(archive);
            using (var p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd();
                p.WaitForExit();
                return output.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch
        {
            return true;   // on doubt, keep the original archive
        }
    }

    static int Run(string exe, string[] args, string replaceFrom, string replaceTo)
    {
        var psi = new ProcessStartInfo(exe);
        psi.UseShellExecute = false;
        var sb = new StringBuilder();
        foreach (string a in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(Quote(replaceFrom != null && a == replaceFrom ? replaceTo : a));
        }
        psi.Arguments = sb.ToString();
        Trace("run " + exe + " " + psi.Arguments);
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    /// minimal CommandLineToArgvW-compatible quoting
    static string Quote(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return s;
        var sb = new StringBuilder();
        sb.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            int backslashes = 0;
            while (i < s.Length && s[i] == '\\') { backslashes++; i++; }
            if (i == s.Length)
            {
                sb.Append('\\', backslashes * 2);
                break;
            }
            if (s[i] == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
            }
            else
            {
                sb.Append('\\', backslashes);
                sb.Append(s[i]);
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
