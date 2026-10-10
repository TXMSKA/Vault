import "../../../test/guard.mjs";
const started = performance.now();
try {
  const { counts } = await import("./units.test.mjs"); await import("./entries.test.mjs"); await import("./link.test.mjs"); await import("./update.test.mjs");
  console.log(`Vault app: ${counts.checks} checks passed in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
} catch (error) {
  // Assertions and crypto errors can include input. Only static test locations reach output.
  console.error(`Vault app tests failed: ${error?.name === "AssertionError" ? "assertion" : "operation"}.`);
  if (error?.generatedMessage === false) console.error(error.message);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*(?:units|link|update)\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  process.exitCode = 1;
}
