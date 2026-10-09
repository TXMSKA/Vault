// Copies what tsc does not: the page, its stylesheet and the fonts (with their licences) go beside the compiled renderer.
// Usage: node scripts/assets.mjs. Run after the renderer is compiled; `npm run build` does both.
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/renderer/", import.meta.url)), out = fileURLToPath(new URL("../dist/renderer/", import.meta.url));
mkdirSync(out, { recursive: true });
for (const name of ["index.html", "app.css", "fonts"]) cpSync(source + name, out + name, { recursive: true, force: true });
