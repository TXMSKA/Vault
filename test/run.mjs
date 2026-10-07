try {
  await import("./vault.test.mjs");
  await import("./shared.test.mjs");
} catch (error) {
  // Assertion output can contain the synthetic secrets under test.
  console.error(`Vault tests failed: ${error?.name === "AssertionError" ? "assertion" : "unexpected error"}.`);
  process.exitCode = 1;
}
