import { VaultClientError } from "../../client/src/index.ts";
export function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return Promise.reject(new VaultClientError("terminal_required"));
  return new Promise((done, fail) => {
    const input = process.stdin, wasRaw = input.isRaw; let value = "";
    process.stderr.write(label); input.setRawMode(true); input.setEncoding("utf8"); input.resume();
    const finish = (error?: VaultClientError) => { input.off("data", read); input.off("end", ended); input.setRawMode(wasRaw); input.pause(); process.stderr.write("\n"); if (error) fail(error); else done(value); value = ""; };
    const ended = () => finish(new VaultClientError("cancelled"));
    const read = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003" || char === "\u0004") { finish(new VaultClientError("cancelled")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " " && value.length < 128) value += char;
      }
    };
    input.on("data", read); input.once("end", ended);
  });
}
