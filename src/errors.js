export class TopicalError extends Error {
  constructor(message, { code = "TOPICAL_ERROR", details } = {}) {
    super(message);
    this.name = "TopicalError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function conflictError(message, details) {
  return new TopicalError(message, { code: "CONFLICT", details });
}
