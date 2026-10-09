import { app } from "electron";
import { start } from "./app.ts";
// The entry point. Electron waits for this file to finish loading before it is ready, and start() registers what Electron needs before that.
start().catch(() => { app.exit(1); });
