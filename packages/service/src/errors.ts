export class ServiceError extends Error {
  code: string; status: number; fields: Record<string, string>;
  constructor(code: string, status = 400, fields: Record<string, string> = {}) { super(code); this.code = code; this.status = status; this.fields = fields; }
}
export function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys) throw new ServiceError("invalid");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 8192): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new ServiceError("invalid"); return value;
}
