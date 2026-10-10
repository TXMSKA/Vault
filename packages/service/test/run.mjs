import "../../../test/guard.mjs";
try { await import("./service.test.mjs"); await import("./sync.test.mjs"); await import("./prompts.test.mjs"); }
catch (error) {
  // Assertions and crypto errors can include input. Only static test locations reach output.
  console.error(`Vault service tests failed: ${error?.name === "AssertionError" ? "assertion" : "operation"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*service\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  // Error codes and Node's own system codes are fixed words, never input, so the chain of causes is printed by code alone.
  const codes = []; for (let cause = error, depth = 0; cause && depth < 6; cause = cause.cause, depth++) { const code = typeof cause.code === "string" && /^[A-Za-z_]{1,40}$/.test(cause.code) ? cause.code : cause?.name; if (code) codes.push(code); }
  if (codes.length) console.error(`Causes: ${codes.join(" < ")}.`);
  process.exitCode = 1;
}
