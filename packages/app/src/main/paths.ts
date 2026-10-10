import { join } from "node:path";
/** What the service keeps inside the vault home. The app's own files are never in one of these. */
export const SERVICE_FOLDERS = ["run", "secrets", "store", "logs", "bin", "sync"] as const;
/**
 * Chromium's own data (cache, storage, preferences) and the app's few files live in a folder of their own inside the vault home, so that
 * `vault uninstall --remove-data`, which deletes the whole home, takes them too.
 */
export const dataFolder = (home: string) => join(home, "app");
