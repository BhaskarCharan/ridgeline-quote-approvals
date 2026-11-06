import type { ErrorRequestHandler } from "express";
import type { Logger } from "pino";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";

/** The single mapping from domain error codes to HTTP statuses. */
const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  validation_failed: 400,
  forbidden: 403,
  not_found: 404,
  invalid_transition: 409,
  conflict: 409,
  upstream_unavailable: 503,
  configuration_invalid: 500,
};

/**
 * The one global error handler. Routes just throw (Express 5 forwards rejected
 * promises here), so every error response has the same shape:
 * `{ error: { code, message, details } }`. Unknown errors become an opaque 500
 * and are logged in full, so internals never leak to clients.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof DomainError) {
      const status = STATUS_BY_CODE[err.code];
      if (status >= 500) logger.error({ err }, err.message);
      else logger.warn({ code: err.code, details: err.details }, err.message);
      res.status(status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (isBodyParseError(err)) {
      res.status(400).json({ error: { code: "validation_failed", message: "Malformed JSON body", details: {} } });
      return;
    }
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ error: { code: "internal_error", message: "Internal server error", details: {} } });
  };
}

/** express.json() signals bad JSON with a SyntaxError carrying `type: "entity.parse.failed"`. */
function isBodyParseError(err: unknown): boolean {
  return err instanceof SyntaxError && "type" in err && err.type === "entity.parse.failed";
}
