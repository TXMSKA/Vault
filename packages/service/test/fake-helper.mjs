// A stand-in for the native helper, used only by the runner tests. A copy of node loads it through --import, answers the way
// VAULT_FAKE_HELPER says and exits before node looks for the script it was given, so the runner starts it like the real helper.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

const mode = process.env.VAULT_FAKE_HELPER, log = process.env.VAULT_FAKE_LOG, verb = basename(process.argv[1] ?? "");
let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { input += chunk; });
await new Promise(done => process.stdin.on("end", done));
const good = { "hello-available": '{"available":true}\n', "dpapi-protect": '{"data":"AAAA"}\n', "user-path-remove": '{"changed":false}\n' }[verb] ?? "{}\n";
const outputs = {
  ok: [good, 0], record: [good, 0], garbage: ["not json\n", 0], extra: ['{"available":true,"extra":"x"}\n', 0], type: ['{"available":"yes"}\n', 0],
  "two-lines": ['{"available":true}\n{"available":true}\n', 0], "no-newline": ['{"available":true}', 0], empty: ["", 0], array: ['[{"available":true}]\n', 0],
  nonzero: ['{"available":true}\n', 3], huge: [`${"x".repeat(70000)}\n`, 0], proto: ['{"__proto__":{"available":true}}\n', 0],
};
if (mode === "record") writeFileSync(log, JSON.stringify({ verb, args: process.argv.slice(2), input, environment: JSON.stringify(process.env) }));
if (mode === "hang") { writeFileSync(log, String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {}); }
const [text, code] = outputs[mode] ?? ["", 9];
process.stdout.write(text, () => process.exit(code));
await new Promise(() => {});
