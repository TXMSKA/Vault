export class VaultClientError extends Error {
  code: string;
  /** The prompt to wait for when a key needs approval. */
  prompt?: string;
  constructor(code: string, options?: ErrorOptions & { prompt?: string }) { super(code, options); this.code = code; this.prompt = options?.prompt; this.name = "VaultClientError"; }
}
