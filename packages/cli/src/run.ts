import { resolve } from "node:path";
import { readCapped, VaultClientError } from "../../client/src/index.ts";
import type { Client, RunProgress, RunRequest, RunSummary } from "../../client/src/types.ts";
import { copy, yes, no } from "./copy.ts";
import { foregroundWindow } from "./window.ts";
import type { CliIO } from "./main.ts";
export const AGENTS: Record<string, string> = { agent: "Agent", "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode", antigravity: "Antigravity", copilot: "GitHub Copilot" };
export type RunOptions = { project?: string; agent?: string; batch?: string; attach?: string; command?: string[] };
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const flags: Record<string, "project" | "agent" | "batch" | "attach"> = { "--project": "project", "--agent": "agent", "--batch": "batch", "--attach": "attach" };
/** Reads the flags before "--"; returns nothing when they do not form one of the run commands. */
export function runOptions(args: string[], appId: RegExp): RunOptions | undefined {
  const options: RunOptions = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--") { options.command = args.slice(i + 1); break; }
    const key = flags[args[i]]; if (!key || options[key] !== undefined || args[i + 1] === undefined) return undefined;
    options[key] = args[++i];
  }
  const valid = options.attach !== undefined ? options.project === undefined && options.batch === undefined && options.command === undefined : !!options.project && !!options.command?.length !== (options.batch !== undefined);
  return valid && (options.agent === undefined || appId.test(options.agent)) ? options : undefined;
}
async function commands(options: RunOptions): Promise<string[][]> {
  if (options.command) return [options.command];
  let value: unknown;
  try { value = JSON.parse(await readCapped(resolve(options.batch!), 256 * 1024)); } catch { throw new VaultClientError("invalid"); }
  if (!Array.isArray(value) || !value.length || !value.every(argv => Array.isArray(argv) && argv.length && argv.every(arg => typeof arg === "string"))) throw new VaultClientError("invalid");
  return value as string[][];
}
// The request carries this terminal's folder and environment, so a command finds what it would find here.
function request(project: string, list: string[][]): RunRequest {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[^=\0]{1,256}$/.test(entry[0]) && entry[1].length <= 32768 && !entry[1].includes("\0")));
  return { project, commands: list, cwd: process.cwd(), env };
}
/** Control, invisible and direction characters are shown as escapes, so a request cannot disguise what it runs. */
export const visible = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
export const commandLine = (argv: string[]) => argv.map(arg => !arg || /[\s"'`$&|;<>()^%!*?]/.test(arg) ? `"${visible(arg).replace(/"/g, '\\"')}"` : visible(arg)).join(" ");
export function describe(io: CliIO, batch: RunSummary, now = Date.now()) {
  const count = batch.commands.length, minutes = Math.max(0, Math.ceil((Date.parse(batch.expiresAt) - now) / 60000)), name = visible(batch.app.name), project = visible(batch.project);
  io.write(copy(`${name} asks to run ${count === 1 ? "1 command" : `${count} commands`} with the values of "${project}".`, `${name} pide ejecutar ${count === 1 ? "1 comando" : `${count} comandos`} con las variables de "${project}".`));
  io.write(copy(`Folder: ${visible(batch.cwd)}`, `Carpeta: ${visible(batch.cwd)}`));
  for (const argv of batch.commands) io.write(`  ${commandLine(argv)}`);
  if (batch.problem) io.write(copy(`"${project}" ${batch.problem === "missing" ? "is not in Vault" : "names more than one entry in Vault"}, so approving fails.`, `"${project}" ${batch.problem === "missing" ? "no está en Vault" : "nombra más de una entrada de Vault"}, así que aprobar falla.`));
  else if (batch.short?.length) io.write(copy(`Shown as they are in the output, shorter than 4 characters: ${batch.short.join(", ")}.`, `Se ven tal cual en la salida, tienen menos de 4 caracteres: ${batch.short.join(", ")}.`));
  io.write(copy("The commands receive the values. Vault hides them in what the commands print, but a command, or a script it runs, can still save them somewhere else.", "Los comandos reciben las variables. Vault las oculta en lo que imprimen, pero un comando, o un script que ejecute, puede guardarlas en otro lado."));
  io.write(copy(`Request ${batch.id}, expires in ${minutes} min.`, `Pedido ${batch.id}, vence en ${minutes} min.`));
}
async function prove(api: Client, io: CliIO, id: string, password?: string) {
  const typed = password ?? await io.ask(copy("Master password, or press Enter to use Windows Hello: ", "Contraseña maestra, o Enter para usar Windows Hello: "));
  try {
    if (typed) { await api.runs.approve(id, typed); return; }
    await api.runs.approveWithHello(id, await foregroundWindow());
  } catch (error) {
    if (!(error instanceof VaultClientError)) throw error;
    if (error.code === "locked") throw new VaultClientError("not_verified");
    if (!typed && ["not_found", "unavailable"].includes(error.code)) throw new VaultClientError("hello_unavailable");
    throw error;
  }
}
function ended(io: CliIO, progress: RunProgress): number {
  if (progress.commands.some(command => command.truncated)) io.error(copy("Part of the output was left out: each command keeps at most 1 MB.", "Se omitió parte de la salida: cada comando guarda hasta 1 MB."));
  if (progress.status === "done") return 0;
  const failed = progress.commands.find(command => command.status === "failed"), notes: Record<string, [string, string]> = {
    rejected: ["The request was rejected. Nothing ran.", "Se rechazó el pedido. No se ejecutó nada."],
    expired: ["The request expired without an answer. Nothing ran.", "El pedido venció sin respuesta. No se ejecutó nada."],
    stopped: ["The run was stopped.", "Se detuvo la ejecución."],
    project: ["The project is not in Vault. Nothing ran.", "El proyecto no está en Vault. No se ejecutó nada."],
    conflict: ["More than one entry in Vault has this project's name. Nothing ran.", "Hay más de una entrada en Vault con el nombre de este proyecto. No se ejecutó nada."],
    not_found: ["The command was not found.", "No se encontró el comando."],
    unsafe_argument: ["A .cmd or .bat file cannot take \" % ! ^ & | < > in its arguments. Run the program itself instead.", "Un archivo .cmd o .bat no puede recibir \" % ! ^ & | < > en sus argumentos. Ejecutá el programa directamente."],
    timeout: ["A command ran for more than 15 minutes and was stopped.", "Un comando pasó los 15 minutos y se detuvo."],
    not_started: ["A command could not start.", "Un comando no pudo arrancar."],
  };
  const note = progress.status !== "failed" ? notes[progress.status] : progress.reason === "not_found" ? notes.project : progress.reason ? notes[progress.reason] : failed?.reason ? notes[failed.reason] : undefined;
  if (note) io.error(copy(...note));
  return failed?.exit || 1;
}
/** Prints a batch's masked output as it arrives and returns the exit code of the command that ended it. */
export async function follow(api: Client, io: CliIO, id: string, wait = pause): Promise<number> {
  let after = 0, misses = 0;
  for (;;) {
    let progress: RunProgress;
    try { progress = await api.runs.get(id, after); misses = 0; }
    catch (error) {
      // While a person confirms with Windows Hello the service answers nothing else for a while.
      if (error instanceof VaultClientError && ["busy", "unavailable", "rate_limited"].includes(error.code) && ++misses < 240) { await wait(500); continue; }
      throw error instanceof VaultClientError && error.code === "not_found" ? new VaultClientError("run_not_found") : error;
    }
    for (const chunk of progress.chunks) (chunk.stream === "stdout" ? io.out : io.err)(chunk.text);
    after = progress.next;
    if (progress.more) continue;
    if (progress.status !== "pending" && progress.status !== "running") return ended(io, progress);
    await wait(500);
  }
}
/**
 * An agent's run waits for the person, who approves it in their own terminal. A person's own run, typed in a terminal,
 * shows the same request and is approved in place with the master password or Windows Hello. When the Vault app is installed,
 * every run waits in the app's window instead, and the person's own run is no different from an agent's.
 */
export async function run(api: Client, io: CliIO, options: RunOptions, agent?: string, viaApp = false): Promise<number> {
  try {
    if (options.attach !== undefined) return await follow(api, io, options.attach);
    const list = await commands(options);
    if (agent !== undefined || viaApp) {
      const { id } = await api.runs.submit(request(options.project!, list));
      io.error(viaApp ? copy(`Waiting for approval in Vault's window. Request ${id}; it expires in 10 minutes.`, `Esperando aprobación en la ventana de Vault. Pedido ${id}; vence en 10 minutos.`) : copy(`Waiting for approval: the person approves it by running "vault approve" in their own terminal. Request ${id}; it expires in 10 minutes.`, `Esperando aprobación: la persona lo aprueba ejecutando "vault approve" en su propia terminal. Pedido ${id}; vence en 10 minutos.`));
      return await follow(api, io, id);
    }
    let password: string | undefined;
    if (!(await api.status()).unlocked) { password = await io.ask(copy("Master password: ", "Contraseña maestra: ")); await api.unlock(password); }
    const { id } = await api.runs.submit(request(options.project!, list)), batch = (await api.runs.list()).find(item => item.id === id);
    if (batch) describe(io, batch);
    await prove(api, io, id, password);
    return await follow(api, io, id);
  } catch (error) {
    if (agent !== undefined && error instanceof VaultClientError && error.code === "pending") {
      io.error(copy(`Vault has not allowed this agent yet. The person allows it once with: vault apps allow ${agent}`, `Vault todavía no autorizó a este agente. La persona lo autoriza una vez con: vault apps allow ${agent}`)); return 1;
    }
    throw error;
  }
}
/** Lists the waiting requests in the person's terminal and approves or rejects each one. */
export async function approve(api: Client, io: CliIO): Promise<number> {
  let password: string | undefined;
  if (!(await api.status()).unlocked) { password = await io.ask(copy("Master password: ", "Contraseña maestra: ")); await api.unlock(password); }
  const waiting = (await api.runs.list()).filter(batch => batch.status === "pending");
  if (!waiting.length) { io.write(copy("No requests are waiting.", "No hay pedidos esperando.")); return 0; }
  for (const batch of waiting) {
    describe(io, batch);
    const answer = await io.ask(copy("Approve? (y/n, Enter leaves it waiting): ", "¿Aprobar? (s/n, Enter lo deja esperando): "));
    if (yes(answer)) { await prove(api, io, batch.id, password); io.write(copy("Approved. The commands are running; their output goes to whoever asked.", "Aprobado. Los comandos se están ejecutando; la salida le llega a quien lo pidió.")); }
    else if (no(answer)) { await api.runs.reject(batch.id); io.write(copy("Rejected.", "Rechazado.")); }
    else io.write(copy("Left waiting.", "Quedó esperando."));
  }
  return 0;
}
