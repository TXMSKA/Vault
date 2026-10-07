import { ServiceError } from "./errors.ts";
export const MAX_VARIABLES = 100;
// The first unescaped closing quote; a double-quoted value can escape its quote with a backslash, kept as written.
function closing(body: string, quote: string) {
  if (quote !== '"') return body.indexOf(quote);
  for (let i = 0; i < body.length; i++) { if (body[i] === "\\") i++; else if (body[i] === '"') return i; }
  return -1;
}
/**
 * Reads a .env file the way the dotenv package does, so Vault stores what the project itself loads: KEY=VALUE lines with an
 * optional export prefix and comments, an unquoted value ending at the first #, quoted values that may span lines, and only
 * \n and \r turned into line breaks inside double quotes. Nothing is expanded.
 */
export function dotenv(input: string): { variables: [string, string][]; skipped: number } {
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/), found = new Map<string, [string, string]>(); let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim() || lines[i].trim().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=[ \t]*(.*)$/.exec(lines[i]);
    if (!match || match[1].length > 100) { skipped++; continue; }
    const rest = match[2], quote = rest[0]; let value: string;
    if (quote === '"' || quote === "'" || quote === "`") {
      let body = rest.slice(1), end = closing(body, quote), last = i;
      while (end < 0 && last + 1 < lines.length) { last++; body += `\n${lines[last]}`; end = closing(body, quote); }
      // An unclosed quote or text after the closing one is skipped whole, so no line is taken as part of another value.
      if (end < 0 || !/^\s*(?:#.*)?$/.test(body.slice(end + 1))) { skipped++; continue; }
      i = last; value = body.slice(0, end);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else value = rest.replace(/#.*$/, "").trim();
    if (value.length > 32000 || value.includes("\0")) { skipped++; continue; }
    found.set(match[1].toLowerCase(), [match[1], value]);
    if (found.size > MAX_VARIABLES) throw new ServiceError("limited", 429);
  }
  return { variables: [...found.values()], skipped };
}
