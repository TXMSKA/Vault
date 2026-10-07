import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { id } from "vault-core";
import type { AppView, RunChunk, RunCommandState, RunProgress, RunStatus, RunSummary } from "../../client/src/types.ts";
import { object, text, ServiceError } from "./errors.ts";
import { Redactor } from "./redact.ts";
export const RUN_LIMITS = { expiresMs: 10 * 60 * 1000, keepMs: 10 * 60 * 1000, commandMs: 15 * 60 * 1000, outputChars: 1024 * 1024, pageChars: 512 * 1024, commands: 10, args: 64, open: 20, pendingPerApp: 3, kept: 50 };
export type RunLimits = typeof RUN_LIMITS;
type Command = RunCommandState & { argv: string[]; size: number };
type Batch = {
  id: string; app: { id: string; name: string }; project: string; cwd: string; env: Record<string, string>; commands: Command[]; status: RunStatus; reason?: string;
  createdAt: number; expiresAt: number; finishedAt?: number; chunks: RunChunk[]; seq: number; stopping: boolean; stop?: () => void;
};
const iso = (time: number) => new Date(time).toISOString();
const system = (file: string) => join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", file);
function request(value: unknown, limits: RunLimits) {
  const v = object(value, "commands,cwd,env,project"), project = text(v.project, 500), cwd = text(v.cwd, 4096);
  if (!project.trim() || !isAbsolute(cwd) || !Array.isArray(v.commands) || !v.commands.length || v.commands.length > limits.commands) throw new ServiceError("invalid");
  const commands = v.commands.map((argv: unknown) => {
    if (!Array.isArray(argv) || !argv.length || argv.length > limits.args) throw new ServiceError("invalid");
    // Tabs and line breaks may be part of an argument; other control characters only disguise what the approver reads.
    const args = argv.map(arg => { const value = text(arg, 8192); if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw new ServiceError("invalid"); return value; });
    if (!args[0].trim()) throw new ServiceError("invalid"); return args;
  });
  if (!v.env || typeof v.env !== "object" || Array.isArray(v.env) || Object.keys(v.env).length > 1000) throw new ServiceError("invalid");
  const env = new Map<string, string>();
  for (const [name, item] of Object.entries(v.env)) { if (!/^[^=\0]{1,256}$/.test(name)) throw new ServiceError("invalid"); env.set(name, text(item, 32768)); }
  return { project, cwd, commands, env: Object.fromEntries(env) };
}
/** Finds a command the way a Windows shell would, through PATH and PATHEXT, limited to programs and batch files. */
function locate(name: string, cwd: string, env: NodeJS.ProcessEnv) {
  const read = (key: string) => Object.entries(env).find(([entry]) => entry.toLowerCase() === key)?.[1];
  const extensions = (read("pathext") || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(extension => [".com", ".exe", ".bat", ".cmd"].includes(extension));
  const endings = extensions.includes(extname(name).toLowerCase()) ? [""] : extensions;
  const folders = /[\\/]/.test(name) || isAbsolute(name) ? [cwd] : (read("path") || "").split(delimiter).map(folder => folder.replace(/^"|"$/g, "")).filter(Boolean);
  for (const folder of folders) for (const ending of endings) {
    const file = resolve(cwd, folder, name + ending);
    try { if (statSync(file).isFile()) return file; } catch {}
  }
}
export function launch(argv: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const options = { cwd, env, stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[], windowsHide: true, shell: false };
  if (process.platform !== "win32") return spawn(argv[0], argv.slice(1), { ...options, detached: true });
  const file = locate(argv[0], cwd, env); if (!file) throw new ServiceError("not_found", 404);
  if (![".bat", ".cmd"].includes(extname(file).toLowerCase())) return spawn(file, argv.slice(1), options);
  // cmd.exe reads a batch file's arguments twice, so the characters it acts on are refused rather than escaped.
  if ([file, ...argv.slice(1)].some(arg => /["%!^&|<>\r\n]/.test(arg))) throw new ServiceError("unsafe_argument");
  const line = [file, ...argv.slice(1)].map(arg => `"${arg.replace(/(\\+)$/, "$1$1")}"`).join(" ");
  return spawn(system("cmd.exe"), ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true });
}
function kill(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawn(system("taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).once("error", () => child.kill());
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
}
/**
 * Batches of commands an app or an agent proposes for one project. A batch waits until a person approves it with the master
 * password or Windows Hello, then the service runs it with the project's values in each command's environment. The values
 * never leave the service: what returns to the caller is the commands' output with every value masked.
 */
export class Runs {
  batches = new Map<string, Batch>(); now: () => number; limits: RunLimits;
  constructor(now: () => number, limits: Partial<RunLimits> = {}) { this.now = now; this.limits = { ...RUN_LIMITS, ...limits }; }
  sweep() {
    for (const [key, batch] of this.batches) {
      if (batch.status === "pending" && this.now() >= batch.expiresAt) this.finish(batch, "expired");
      else if (batch.finishedAt !== undefined && this.now() - batch.finishedAt >= this.limits.keepMs) this.batches.delete(key);
    }
  }
  /** A batch that waits or runs keeps the service up. */
  busy() { this.sweep(); return [...this.batches.values()].some(batch => batch.status === "pending" || batch.status === "running"); }
  submit(app: AppView, value: unknown) {
    this.sweep(); const input = request(value, this.limits), all = [...this.batches.values()], open = all.filter(batch => batch.status === "pending" || batch.status === "running");
    if (open.length >= this.limits.open || open.filter(batch => batch.app.id === app.id && batch.status === "pending").length >= this.limits.pendingPerApp) throw new ServiceError("limited", 429);
    // Finished batches stay for their output; when there are many, the oldest go first.
    const finished = all.filter(batch => batch.finishedAt !== undefined).sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const old of finished.slice(0, Math.max(0, finished.length - this.limits.kept + 1))) this.batches.delete(old.id);
    const created = this.now(), batch: Batch = {
      id: randomUUID(), app: { id: app.id, name: app.name }, project: input.project, cwd: input.cwd, env: input.env, status: "pending", createdAt: created, expiresAt: created + this.limits.expiresMs,
      commands: input.commands.map(argv => ({ argv, status: "waiting", exit: null, truncated: false, size: 0 })), chunks: [], seq: 0, stopping: false,
    };
    this.batches.set(batch.id, batch); return { id: batch.id, expiresAt: iso(batch.expiresAt) };
  }
  list(): RunSummary[] {
    this.sweep();
    return [...this.batches.values()].filter(batch => batch.status === "pending" || batch.status === "running").map(batch => ({
      id: batch.id, project: batch.project, app: { ...batch.app }, cwd: batch.cwd, commands: batch.commands.map(command => [...command.argv]), status: batch.status,
      createdAt: iso(batch.createdAt), expiresAt: iso(batch.expiresAt), short: null,
    }));
  }
  private find(value: unknown) { const batch = this.batches.get(id(value).toLowerCase()); if (!batch) throw new ServiceError("not_found", 404); return batch; }
  /** Only the app that asked, or an app that manages Vault, sees a batch; to any other it does not exist. */
  progress(app: AppView, batchId: unknown, after: unknown, manager: boolean): RunProgress {
    this.sweep(); const batch = this.find(batchId), from = text(after, 12);
    if (batch.app.id !== app.id && !manager) throw new ServiceError("not_found", 404);
    if (!/^(?:0|[1-9][0-9]{0,10})$/.test(from)) throw new ServiceError("invalid");
    const chunks: RunChunk[] = []; let size = 0, more = false;
    for (const chunk of batch.chunks) {
      if (chunk.seq <= Number(from)) continue;
      if (chunks.length && size + chunk.text.length > this.limits.pageChars) { more = true; break; }
      chunks.push({ ...chunk }); size += chunk.text.length;
    }
    return {
      id: batch.id, project: batch.project, status: batch.status, ...(batch.reason ? { reason: batch.reason } : {}), expiresAt: iso(batch.expiresAt),
      commands: batch.commands.map(({ status, exit, reason, truncated }) => ({ status, exit, ...(reason ? { reason } : {}), truncated })), chunks, next: chunks.at(-1)?.seq ?? Number(from), more,
    };
  }
  pending(batchId: unknown) {
    this.sweep(); const batch = this.find(batchId);
    if (batch.status === "expired") throw new ServiceError("expired", 410);
    if (batch.status !== "pending") throw new ServiceError("not_pending", 409);
    return batch;
  }
  fail(batchId: string, reason: string) { this.finish(this.pending(batchId), "failed", reason); }
  reject(batchId: unknown) {
    this.sweep(); const batch = this.find(batchId);
    if (batch.status === "pending") this.finish(batch, "rejected");
    else if (batch.status === "running") { batch.stopping = true; batch.stop?.(); }
    else throw new ServiceError("not_pending", 409);
  }
  /** Starts an approved batch. The values stay in this process: in the children's environment and in the redactor. */
  start(batchId: string, values: Record<string, string>) {
    const batch = this.pending(batchId), env: NodeJS.ProcessEnv = { ...batch.env };
    for (const [name, value] of Object.entries(values)) {
      if (process.platform === "win32") for (const existing of Object.keys(env)) if (existing.toLowerCase() === name.toLowerCase()) delete env[existing];
      env[name] = value;
    }
    batch.status = "running"; batch.env = {};
    void this.execute(batch, env, new Redactor(Object.values(values)));
  }
  stopAll() { for (const batch of this.batches.values()) if (batch.status === "running") { batch.stopping = true; batch.stop?.(); } }
  private finish(batch: Batch, status: RunStatus, reason?: string) {
    batch.status = status; batch.finishedAt = this.now(); batch.env = {}; batch.stop = undefined;
    if (reason) batch.reason = reason;
  }
  private async execute(batch: Batch, env: NodeJS.ProcessEnv, redactor: Redactor) {
    let failed = false;
    try {
      for (let index = 0; index < batch.commands.length; index++) {
        const command = batch.commands[index];
        if (failed || batch.stopping) { command.status = "skipped"; continue; }
        await this.command(batch, command, index, env, redactor);
        if (command.status !== "done") failed = true;
      }
    } catch { failed = true; }
    this.finish(batch, batch.stopping ? "stopped" : failed ? "failed" : "done");
  }
  private command(batch: Batch, command: Command, index: number, env: NodeJS.ProcessEnv, redactor: Redactor) {
    return new Promise<void>(done => {
      let child: ChildProcess;
      try { child = launch(command.argv, batch.cwd, env); }
      catch (error) { command.status = "failed"; command.reason = error instanceof ServiceError ? error.code : "not_started"; done(); return; }
      command.status = "running";
      const streams = { stdout: redactor.stream(), stderr: redactor.stream() }, decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const emit = (stream: "stdout" | "stderr", value: string) => {
        if (!value) return;
        const room = this.limits.outputChars - command.size; if (room <= 0) { command.truncated = true; return; }
        if (value.length > room) { value = value.slice(0, room); command.truncated = true; }
        command.size += value.length; batch.chunks.push({ seq: ++batch.seq, command: index, stream, text: value });
      };
      for (const stream of ["stdout", "stderr"] as const) child[stream]?.on("data", (data: Buffer) => emit(stream, streams[stream].push(decoders[stream].write(data))));
      const timer = setTimeout(() => { command.reason = "timeout"; kill(child); }, this.limits.commandMs); timer.unref();
      batch.stop = () => { command.reason = "stopped"; kill(child); };
      let settled = false;
      const settle = (code: number | null, failure = false) => {
        if (settled) return; settled = true; clearTimeout(timer); batch.stop = undefined;
        for (const stream of ["stdout", "stderr"] as const) { emit(stream, streams[stream].push(decoders[stream].end())); emit(stream, streams[stream].end()); }
        command.exit = code;
        if (failure && !command.reason) command.reason = "not_started";
        command.status = command.reason === "stopped" ? "stopped" : code === 0 && !command.reason ? "done" : "failed";
        done();
      };
      child.once("error", () => settle(null, true));
      child.once("close", (code, signal) => settle(code ?? (signal ? 1 : null)));
    });
  }
}
