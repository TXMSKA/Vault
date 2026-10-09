/** `--prompts` is how the service starts the app when a prompt waits and nobody is there; any other argument is ignored. */
export const parseArgs = (argv: readonly string[]) => ({ prompts: argv.includes("--prompts") });
