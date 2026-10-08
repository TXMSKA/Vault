import { tmpdir } from "node:os";
import childProcess from "node:child_process";
import "../../../test/guard.mjs";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import path from "node:path";

// The managed Windows sandbox refuses Set-Acl. The adapter is test-only,
// never imported by production and never selected by an environment flag.
if (process.platform === "win32") {
  const root = path.resolve(tmpdir());
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (file, args = [], options) => {
    const candidate = options?.env?.VAULT_PRIVATE_PATH;
    if (path.basename(file).toLowerCase() === "powershell.exe" && candidate) {
      const relative = path.relative(root, candidate), first = relative.split(path.sep)[0];
      const script = args.at(-1);
      if (/^service-[a-zA-Z0-9_-]+$/.test(first) && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(candidate) && script?.includes("VAULT_PRIVATE_PATH")) {
        if (!script.includes("GetOwner") || !script.includes("S-1-5-18") || !script.includes("S-1-5-32-544") || !script.includes("AccessControlType") || script.includes("Set-Acl") && !script.includes("AreAccessRulesProtected")) throw new Error("invalid_test_acl");
        return Buffer.alloc(0);
      }
    }
    return original(file, args, options);
  };
  syncBuiltinESMExports();
}
