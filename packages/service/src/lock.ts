import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ServiceError } from "./errors.ts";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
export function acquireLock(home: string): () => void {
  const filename = join(home, "run", "service.lock"), token = randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(filename, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return () => { try { if (JSON.parse(fs.readFileSync(filename, "utf8")).token === token) fs.unlinkSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner;
      try { if (fs.statSync(filename).size > 1024) throw new Error(); owner = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { throw new ServiceError("already_running", 409); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== "string" || alive(owner.pid)) throw new ServiceError("already_running", 409);
      // Only one contender may reap this dead lease; no contender can remove a new lease.
      const claim = join(home, "run", `reap-${owner.token}`); let fd;
      if (!/^[a-f0-9-]{36}$/.test(owner.token)) throw new ServiceError("already_running", 409);
      try { fd = fs.openSync(claim, "wx", 0o600); } catch { throw new ServiceError("already_running", 409); }
      try { if (JSON.parse(fs.readFileSync(filename, "utf8")).token === owner.token) fs.unlinkSync(filename); }
      finally { fs.closeSync(fd); fs.unlinkSync(claim); }
    }
  }
  throw new ServiceError("already_running", 409);
}
