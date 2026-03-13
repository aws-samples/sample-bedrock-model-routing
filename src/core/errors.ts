/**
 * Custom error class for multiplexer-level failures.
 *
 * This is thrown only for failures that are the multiplexer's own concern —
 * e.g., "no models available", "all retries exhausted", "circuit breaker open".
 *
 * SDK errors are re-thrown in their original form so consumers can
 * `instanceof`-check for specific SDK exceptions (ThrottlingException, etc.).
 */
export class MultiplexerError extends Error {
  /** Machine-readable error code */
  public readonly code: string;
  /** Optional structured details */
  public readonly details?: Record<string, any>;

  constructor(message: string, code: string, details?: Record<string, any>) {
    super(message);
    this.name = 'MultiplexerError';
    this.code = code;
    this.details = details;
    // Fix prototype chain for instanceof checks in TypeScript
    Object.setPrototypeOf(this, MultiplexerError.prototype);
  }
}
