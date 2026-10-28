/**
 * An error meant to be shown to the user as-is (no stack trace).
 * `hint` is printed on following lines with suggestions for fixing it.
 */
export class PromptdiffError extends Error {
  readonly hint?: string;

  constructor(message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "PromptdiffError";
    this.hint = options?.hint;
  }
}

/** Thrown when an API call fails in a way that will fail every other call too (bad key, unknown model). */
export class FatalProviderError extends PromptdiffError {
  constructor(message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options);
    this.name = "FatalProviderError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
