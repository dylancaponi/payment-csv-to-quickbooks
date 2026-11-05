// User-facing error type. `message` is written for end users and is safe to
// show in the UI as-is. `code` is a stable machine-readable identifier.
export class EngineError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details) {
  throw new EngineError(code, message, details);
}
