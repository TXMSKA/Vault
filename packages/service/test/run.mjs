import "../../../test/guard.mjs";
try { await import("./service.test.mjs"); await import("./sync.test.mjs"); }
catch (error) {
  // Assertions and crypto errors can include input. Only static test locations reach output.
  console.error(`Vault service tests failed: ${error?.name === "AssertionError" ? "assertion" : "operation"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*service\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  process.exitCode = 1;
}
