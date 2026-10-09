import { tmpdir } from "node:os";
import childProcess from "node:child_process";
import "../../../test/guard.mjs";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

// The managed Windows sandbox refuses the ACL change. The adapter is test-only,
// never imported by production and never selected by an environment flag. It
// answers the helper's protect-folder and check-file verbs, and only for synthetic
// service scratch folders; every other call, including the real helper on any
// other folder, runs for real.
if (process.platform === "win32") {
  const root = path.resolve(tmpdir());
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (file, args = [], options = {}) => {
    if (path.basename(file).toLowerCase() === "vault-helper.exe" && ["protect-folder", "check-file"].includes(args[0])) {
      let request; try { request = JSON.parse(String(options.input)); } catch { request = undefined; }
      const candidate = typeof request?.path === "string" ? request.path : "";
      const relative = path.relative(root, candidate), first = relative.split(path.sep)[0];
      if (candidate && /^service-[a-zA-Z0-9_-]+$/.test(first) && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(candidate)) {
        if (args.length !== 1 || Object.keys(request).join() !== "path" || options.shell || !String(options.input).endsWith("\n")) throw new Error("invalid_test_acl");
        const stdout = Buffer.from('{"ok":true}\n');
        return { pid: 0, status: 0, signal: null, output: [null, stdout, null], stdout, stderr: Buffer.alloc(0) };
      }
    }
    return original(file, args, options);
  };
  // The client's async form sends the same request through spawn; the same synthetic folders get the same answer.
  const scratchPath = candidate => { const relative = path.relative(root, candidate), first = relative.split(path.sep)[0]; return Boolean(candidate) && /^service-[a-zA-Z0-9_-]+$/.test(first) && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(candidate); };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (file, args = [], options = {}) => {
    if (path.basename(String(file)).toLowerCase() !== "vault-helper.exe" || !["protect-folder", "check-file"].includes(args[0])) return originalSpawn(file, args, options);
    const child = new EventEmitter(), stdout = new PassThrough(); let input = "";
    const answer = () => {
      let request; try { request = JSON.parse(input); } catch { request = undefined; }
      if (scratchPath(typeof request?.path === "string" ? request.path : "")) {
        if (args.length !== 1 || Object.keys(request).join() !== "path" || options.shell || !input.endsWith("\n")) { child.emit("error", new Error("invalid_test_acl")); return; }
        stdout.end('{"ok":true}\n'); setImmediate(() => child.emit("close", 0)); return;
      }
      const real = originalSpawn(file, args, options); real.stdout.pipe(stdout); real.on("error", error => child.emit("error", error)); real.on("close", code => child.emit("close", code)); real.stdin.end(input);
    };
    child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk; done(); }, final(done) { done(); setImmediate(answer); } });
    child.stdout = stdout; child.kill = () => true;
    return child;
  };
  syncBuiltinESMExports();
}
