import { errorCode, VaultError } from "./store.js";

export type LogRecord = { time: string; event: string; fields: Record<string, string | number | boolean | null> };
export type VaultLogger = (event: string, fields?: Record<string, unknown>) => void;
const secret = /password|passphrase|secret|token|proof|key|recovery|authorization|cookie|credential|body|payload|value|entry|sealed|salt|hash|card|pin|totp|email|address|securitycode|cvv|cvc|license|username|note|title|fields|files|master|data|^iv$|^number$/i;
const token = /[A-Za-z0-9+/_=-]{24,}|\b\d{12,19}\b|\b[A-HJ-NP-Z2-9]{4}(?:\s*-\s*[A-HJ-NP-Z2-9]{4}){5}\b/i;
function clean(value: unknown): string | number | boolean | null {
  if (value instanceof Error) return errorCode(value);
  if (typeof value === "string") return token.test(value) || /[\r\n\x00-\x1f]/.test(value) ? "[redacted]" : value.slice(0, 180);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  return "[redacted]";
}
// Only named scalar fields reach the sink; arbitrary objects and error details never do.
export function createLogger(sink: (record: LogRecord) => void, clock = Date.now): VaultLogger {
  return (event, fields = {}) => {
    try {
      const safe = Object.fromEntries(Object.entries(fields).map(([name, value]) => {
        const safeName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && !token.test(name) ? name : "redacted";
        return [safeName, secret.test(name) || safeName === "redacted" ? "[redacted]" : clean(value)];
      }));
      sink({ time: new Date(clock()).toISOString(), event: clean(event) as string, fields: safe });
    } catch { throw new VaultError("unavailable"); }
  };
}
