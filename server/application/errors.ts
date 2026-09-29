export class ProfileCommitError extends Error {}

export class ApplicationError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "not-found" | "unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
