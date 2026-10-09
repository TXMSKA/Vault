// Vault's native helper. One verb per run: argv[1] names it, one JSON line on stdin carries the request, one JSON line on stdout answers.
// Built by scripts/build-helper.mjs with the .NET Framework 4 compiler (C# 5). A failure exits non-zero with a fixed word on stderr and never echoes a value.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Windows.Security.Credentials.UI;

// Desktop verification needs the host HWND, rather than a UWP CoreWindow.
[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
interface IUserConsentVerifierInterop {
  [return: MarshalAs(UnmanagedType.IInspectable)]
  object RequestVerificationForWindowAsync(IntPtr window, IntPtr message, ref Guid iid);
}

sealed class Refused : Exception { }

static class VaultHelper {
  const int Cap = 65536;
  const string SystemSid = "S-1-5-18", AdministratorsSid = "S-1-5-32-544";

  [DllImport("combase.dll")] static extern int RoInitialize(uint type);
  [DllImport("combase.dll")] static extern void RoUninitialize();
  [DllImport("combase.dll", PreserveSig = false)] static extern void WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string value, int length, out IntPtr result);
  [DllImport("combase.dll", PreserveSig = false)] static extern void WindowsDeleteString(IntPtr value);
  [DllImport("combase.dll", PreserveSig = false)] static extern void RoGetActivationFactory(IntPtr name, ref Guid iid, [MarshalAs(UnmanagedType.IInspectable)] out object factory);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, string lparam, uint flags, uint timeout, out UIntPtr result);

  [STAThread]
  static int Main(string[] args) {
    byte[] output = null;
    try {
      if (args.Length != 1) throw new Refused();
      output = new UTF8Encoding(false).GetBytes(Dispatch(args[0]) + "\n");
      Stream stdout = Console.OpenStandardOutput(); stdout.Write(output, 0, output.Length); stdout.Flush();
      return 0;
    }
    catch (Refused) { Console.Error.Write("invalid"); return 2; }
    catch (Exception) { Console.Error.Write("failed"); return 1; }
    finally { if (output != null) Array.Clear(output, 0, output.Length); }
  }

  static string Dispatch(string verb) {
    switch (verb) {
      case "hello-available": Request(); return "{\"available\":" + (Available() ? "true" : "false") + "}";
      case "hello-verify": { Dictionary<string, string> fields = Request("hwnd", "message"); return "{\"result\":" + Quote(Verify(Handle(fields["hwnd"]), Message(fields["message"]))) + "}"; }
      case "dpapi-protect": return Seal(Request("data")["data"], true);
      case "dpapi-unprotect": return Seal(Request("data")["data"], false);
      case "foreground-window": Request(); return "{\"hwnd\":" + Quote(Foreground()) + "}";
      case "protect-folder": ProtectFolder(Absolute(Request("path")["path"])); return "{\"ok\":true}";
      case "check-file": CheckFile(Absolute(Request("path")["path"])); return "{\"ok\":true}";
      case "user-path-add": return "{\"changed\":" + (ChangeUserPath(Absolute(Request("path")["path"]), true) ? "true" : "false") + "}";
      case "user-path-remove": return "{\"changed\":" + (ChangeUserPath(Absolute(Request("path")["path"]), false) ? "true" : "false") + "}";
      default: throw new Refused();
    }
  }

  // Windows Hello.
  [MethodImpl(MethodImplOptions.NoInlining)]
  static bool Available() {
    return Wait(UserConsentVerifier.CheckAvailabilityAsync()) == UserConsentVerifierAvailability.Available;
  }

  // The compiler has no Windows.winmd to resolve AsTask, so the wait is a completion handler and an event.
  static T Wait<T>(Windows.Foundation.IAsyncOperation<T> operation) {
    using (ManualResetEvent done = new ManualResetEvent(false)) {
      operation.Completed = delegate(Windows.Foundation.IAsyncOperation<T> finished, Windows.Foundation.AsyncStatus status) { done.Set(); };
      done.WaitOne();
      return operation.GetResults();
    }
  }

  // The apartment stays initialized until the person answers, so the wait sits inside the try.
  [MethodImpl(MethodImplOptions.NoInlining)]
  static string Verify(long window, string text) {
    IntPtr name = IntPtr.Zero, message = IntPtr.Zero; object factory = null;
    int initialized = RoInitialize(0);
    if (initialized < 0 && initialized != unchecked((int)0x80010106)) Marshal.ThrowExceptionForHR(initialized);
    try {
      string type = "Windows.Security.Credentials.UI.UserConsentVerifier";
      WindowsCreateString(type, type.Length, out name); WindowsCreateString(text, text.Length, out message);
      Guid iid = typeof(IUserConsentVerifierInterop).GUID; RoGetActivationFactory(name, ref iid, out factory);
      Guid operationId = typeof(Windows.Foundation.IAsyncOperation<UserConsentVerificationResult>).GUID;
      object operation = ((IUserConsentVerifierInterop)factory).RequestVerificationForWindowAsync(new IntPtr(window), message, ref operationId);
      return Wait((Windows.Foundation.IAsyncOperation<UserConsentVerificationResult>)operation).ToString();
    } finally {
      if (factory != null) Marshal.ReleaseComObject(factory);
      if (message != IntPtr.Zero) WindowsDeleteString(message);
      if (name != IntPtr.Zero) WindowsDeleteString(name);
      if (initialized >= 0) RoUninitialize();
    }
  }

  // DPAPI, current user scope. Byte arrays are cleared once the answer is built.
  static string Seal(string text, bool protect) {
    if (text.Length == 0 || text.Length > 22000 || text.Length % 4 != 0) throw new Refused();
    foreach (char c in text) if (!(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/' || c == '=')) throw new Refused();
    byte[] input = null, result = null;
    try {
      try { input = Convert.FromBase64String(text); } catch (FormatException) { throw new Refused(); }
      if (input.Length == 0 || input.Length > 16384) throw new Refused();
      result = protect ? ProtectedData.Protect(input, null, DataProtectionScope.CurrentUser) : ProtectedData.Unprotect(input, null, DataProtectionScope.CurrentUser);
      return "{\"data\":\"" + Convert.ToBase64String(result) + "\"}";
    } finally {
      if (input != null) Array.Clear(input, 0, input.Length);
      if (result != null) Array.Clear(result, 0, result.Length);
    }
  }

  static string Foreground() {
    long window = GetForegroundWindow().ToInt64();
    if (window < 1) throw new InvalidOperationException();
    return window.ToString(CultureInfo.InvariantCulture);
  }

  // Fresh descriptor: only the owner and the access list, protected from inheritance, then read back and checked.
  static void ProtectFolder(string path) {
    DirectoryInfo folder = new DirectoryInfo(path);
    if (!folder.Exists || (folder.Attributes & FileAttributes.ReparsePoint) != 0) throw new Refused();
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
      SecurityIdentifier user = identity.User;
      List<string> allowed = Allowed(user);
      DirectorySecurity acl = new DirectorySecurity(); acl.SetOwner(user); acl.SetAccessRuleProtection(true, false);
      foreach (string sid in allowed) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      folder.SetAccessControl(acl);
      DirectorySecurity actual = folder.GetAccessControl();
      if (!actual.AreAccessRulesProtected) throw new InvalidOperationException();
      Audit(actual, user, allowed);
    }
  }

  static void CheckFile(string path) {
    FileInfo file = new FileInfo(path);
    if (!file.Exists || (file.Attributes & FileAttributes.ReparsePoint) != 0) throw new Refused();
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) Audit(file.GetAccessControl(), identity.User, Allowed(identity.User));
  }

  static List<string> Allowed(SecurityIdentifier user) { return new List<string>(new string[] { user.Value, SystemSid, AdministratorsSid }); }

  // The owner is the current user and every rule, inherited ones too, allows only the user, SYSTEM or Administrators.
  static void Audit(CommonObjectSecurity security, SecurityIdentifier user, List<string> allowed) {
    if (!user.Equals(security.GetOwner(typeof(SecurityIdentifier)))) throw new InvalidOperationException();
    foreach (AuthorizationRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      AccessRule access = (AccessRule)rule;
      if (access.AccessControlType != AccessControlType.Allow || !allowed.Contains(access.IdentityReference.Value)) throw new InvalidOperationException();
    }
  }

  // Reads the user Path without expanding it, keeps its kind, adds or removes the folder, then tells running programs so new terminals see it.
  // The answer is whether the Path changed: adding a folder already there, or removing one that is not, writes nothing.
  static bool ChangeUserPath(string folder, bool add) {
    if (folder.IndexOf(';') >= 0) throw new Refused();
    using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Environment", true)) {
      if (key == null) throw new InvalidOperationException();
      bool has = false;
      foreach (string name in key.GetValueNames()) if (string.Equals(name, "Path", StringComparison.OrdinalIgnoreCase)) has = true;
      string current = has ? key.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string : "";
      RegistryValueKind kind = has ? key.GetValueKind("Path") : RegistryValueKind.ExpandString;
      if (current == null || kind != RegistryValueKind.String && kind != RegistryValueKind.ExpandString) throw new InvalidOperationException();
      List<string> parts = new List<string>();
      foreach (string part in current.Split(';')) if (part.Length > 0) parts.Add(part);
      if (!EditPath(parts, folder, add)) return false;
      key.SetValue("Path", string.Join(";", parts.ToArray()), kind);
    }
    UIntPtr ignored; SendMessageTimeout(new IntPtr(0xffff), 0x001A, UIntPtr.Zero, "Environment", 0x0002, 5000, out ignored);
    return true;
  }

  // The folder is matched without regard to case, as Windows matches paths. True when the list changed.
  static bool EditPath(List<string> parts, string folder, bool add) {
    bool found = parts.Exists(delegate(string part) { return string.Equals(part, folder, StringComparison.OrdinalIgnoreCase); });
    if (add) { if (found) return false; parts.Add(folder); return true; }
    return parts.RemoveAll(delegate(string part) { return string.Equals(part, folder, StringComparison.OrdinalIgnoreCase); }) > 0;
  }

  // Arguments.
  static long Handle(string text) {
    long window;
    if (text.Length == 0 || text.Length > 19 || text[0] == '0' || !long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out window) || window < 1) throw new Refused();
    return window;
  }

  static string Message(string text) {
    if (text.Length == 0 || text.Length > 256) throw new Refused();
    foreach (char c in text) if (c < ' ' || c == '\u007f') throw new Refused();
    return text;
  }

  static string Absolute(string path) {
    if (path.Length < 3 || path.Length > 4096 || !(path[0] >= 'A' && path[0] <= 'Z' || path[0] >= 'a' && path[0] <= 'z') || path[1] != ':' || path[2] != '\\') throw new Refused();
    foreach (char c in path) if (c < ' ') throw new Refused();
    string full;
    try { full = Path.GetFullPath(path); } catch (Exception) { throw new Refused(); }
    if (!string.Equals(full, path, StringComparison.OrdinalIgnoreCase)) throw new Refused();
    return path;
  }

  // The request: one JSON line, at most 64 KiB, an object of string values whose keys are exactly the verb's.
  static Dictionary<string, string> Request(params string[] keys) {
    byte[] bytes = new byte[Cap + 1]; int count = 0;
    try {
      Stream input = Console.OpenStandardInput();
      for (;;) {
        int read = input.Read(bytes, count, bytes.Length - count);
        if (read <= 0) break;
        count += read;
        if (count > Cap) throw new Refused();
      }
      string text;
      try { text = new UTF8Encoding(false, true).GetString(bytes, 0, count); } catch (ArgumentException) { throw new Refused(); }
      if (text.EndsWith("\r\n", StringComparison.Ordinal)) text = text.Substring(0, text.Length - 2);
      else if (text.EndsWith("\n", StringComparison.Ordinal)) text = text.Substring(0, text.Length - 1);
      Dictionary<string, string> fields = Parse(text);
      if (fields.Count != keys.Length) throw new Refused();
      foreach (string key in keys) if (!fields.ContainsKey(key)) throw new Refused();
      return fields;
    } finally { Array.Clear(bytes, 0, bytes.Length); }
  }

  static Dictionary<string, string> Parse(string text) {
    Dictionary<string, string> fields = new Dictionary<string, string>(StringComparer.Ordinal); int i = 0;
    Space(text, ref i); Expect(text, ref i, '{'); Space(text, ref i);
    if (i < text.Length && text[i] == '}') i++;
    else for (;;) {
      string key = Str(text, ref i); Space(text, ref i); Expect(text, ref i, ':'); Space(text, ref i);
      string value = Str(text, ref i);
      if (fields.ContainsKey(key)) throw new Refused();
      fields.Add(key, value); Space(text, ref i);
      if (i < text.Length && text[i] == ',') { i++; Space(text, ref i); continue; }
      Expect(text, ref i, '}'); break;
    }
    Space(text, ref i);
    if (i != text.Length) throw new Refused();
    return fields;
  }

  static void Space(string text, ref int i) { while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++; }

  static void Expect(string text, ref int i, char c) {
    if (i >= text.Length || text[i] != c) throw new Refused();
    i++;
  }

  static string Str(string text, ref int i) {
    Expect(text, ref i, '"');
    StringBuilder value = new StringBuilder();
    for (;;) {
      if (i >= text.Length) throw new Refused();
      char c = text[i++];
      if (c == '"') return value.ToString();
      if (c < ' ') throw new Refused();
      if (c != '\\') { value.Append(c); continue; }
      if (i >= text.Length) throw new Refused();
      c = text[i++];
      switch (c) {
        case '"': case '\\': case '/': value.Append(c); break;
        case 'b': value.Append('\b'); break;
        case 'f': value.Append('\f'); break;
        case 'n': value.Append('\n'); break;
        case 'r': value.Append('\r'); break;
        case 't': value.Append('\t'); break;
        case 'u':
          if (i + 4 > text.Length) throw new Refused();
          int code = 0;
          for (int k = 0; k < 4; k++) { int digit = "0123456789abcdef".IndexOf(char.ToLowerInvariant(text[i + k])); if (digit < 0) throw new Refused(); code = code * 16 + digit; }
          i += 4; value.Append((char)code); break;
        default: throw new Refused();
      }
    }
  }

  static string Quote(string value) {
    StringBuilder quoted = new StringBuilder("\"");
    foreach (char c in value) {
      if (c == '"' || c == '\\') quoted.Append('\\').Append(c);
      else if (c < ' ' || c > '~') quoted.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      else quoted.Append(c);
    }
    return quoted.Append('"').ToString();
  }
}
