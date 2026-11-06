/**
 * Stable, machine-readable error codes. The API layer maps these to HTTP
 * statuses in one place (the global error handler), so the domain never knows
 * about HTTP and every failure has a consistent response shape.
 */
export type DomainErrorCode =
  | "validation_failed"
  | "not_found"
  | "forbidden"
  | "invalid_transition"
  | "conflict"
  | "upstream_unavailable"
  | "configuration_invalid";

/**
 * Base class for every expected failure. Anything that is *not* a DomainError
 * reaching the error handler is a bug and is reported as a 500 without leaking
 * internals.
 */
export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  constructor(
    message: string,
    /** Safe-to-expose context for the client and the logs. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input did not match the expected shape (request body, draft file, CSV row). */
export class ValidationError extends DomainError {
  readonly code = "validation_failed";
}

/** A referenced quote, customer, product or approver does not exist. */
export class NotFoundError extends DomainError {
  readonly code = "not_found";
}

/**
 * The caller is not allowed to act: e.g. a manager approving a quote routed to
 * someone else. Enforces "only a specialist or the routed approver can approve".
 */
export class ForbiddenError extends DomainError {
  readonly code = "forbidden";
}

/**
 * The quote is not in a state that allows this action, e.g. approving a quote
 * that is already approved, or manager approval before specialist sign-off.
 * This is what keeps a quote from reaching a customer without human approval.
 */
export class InvalidTransitionError extends DomainError {
  readonly code = "invalid_transition";
}

/** Concurrent modification detected (optimistic version mismatch). */
export class ConflictError extends DomainError {
  readonly code = "conflict";
}

/**
 * An upstream read-only dependency (stock API, reporting data) could not be
 * reached after retries. Pricing/routing should usually *flag* rather than
 * throw; this is for the cases where there is genuinely nothing to show.
 */
export class UpstreamUnavailableError extends DomainError {
  readonly code = "upstream_unavailable";
}

/** Startup configuration (env, approval policy YAML) is invalid. Fail fast. */
export class ConfigurationError extends DomainError {
  readonly code = "configuration_invalid";
}
