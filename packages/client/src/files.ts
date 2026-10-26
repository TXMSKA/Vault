import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { VaultClientError } from "./errors.ts";
export const FILE_CAP = 8 * 1024 * 1024;
export async function readCapped(filename: string, cap = FILE_CAP): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > cap) throw new VaultClientError("too_large");
    const bytes = Buffer.alloc(cap + 1); let count = 0;
    while (count <= cap) { const part = await file.read(bytes, count, bytes.length - count, count); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > cap) throw new VaultClientError("too_large");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)); }
    finally { bytes.fill(0); }
  } finally { await file.close(); }
}
/** Reads the header without loading the encrypted backup's remaining lines. */
export async function readFirstLine(filename: string, cap = FILE_CAP): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), bytes = Buffer.alloc(4096);
  try {
    if (!(await file.stat()).isFile()) throw new VaultClientError("too_large");
    const decoder = new TextDecoder("utf-8", { fatal: true }), parts: string[] = []; let count = 0;
    for (;;) {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null); if (!bytesRead) break;
      const newline = bytes.subarray(0, bytesRead).indexOf(10), length = newline < 0 ? bytesRead : newline;
      count += length; if (count > cap) throw new VaultClientError("too_large");
      parts.push(decoder.decode(bytes.subarray(0, length), { stream: true })); if (newline >= 0) break;
    }
    parts.push(decoder.decode()); return parts.join("");
  } finally { bytes.fill(0); await file.close(); }
}
export async function atomicJson(filename: string, value: unknown) { await atomicText(filename, JSON.stringify(value)); }
// Windows refuses to replace a file while another process has it open (a client reading service.json, an antivirus scan),
// so the swap is tried again for up to about three seconds before the error is passed on.
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
async function replace(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) { if (process.platform !== "win32" || attempt >= 30 || !BUSY.has((error as NodeJS.ErrnoException).code ?? "")) throw error; await new Promise(done => setTimeout(done, Math.min(200, 10 * 2 ** attempt))); }
  }
}
export async function atomicText(filename: string, text: string, mode = 0o600) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", mode);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await replace(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}
