import type { ErrorRequestHandler } from "express";
import type { Logger } from "pino";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";

/** The single mapping from domain error codes to HTTP statuses. */
const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_transition: 409,
  conflict: 409,
  not_implemented: 501,
  upstream_unavailable: 503,
  configuration_invalid: 500,
};

/** Every error response has exactly this shape. */
export interface ErrorBody {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/**
 * The one global error handler. Routes just throw (Express 5 forwards rejected
 * promises here), so every error response is `{ code, message, details }`.
 * Unknown errors become an opaque 500 and are logged in full, so internals
 * never leak to clients.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const send = (status: number, body: ErrorBody): void => {
      res.status(status).json(body);
    };

    if (err instanceof DomainError) {
      const status = STATUS_BY_CODE[err.code];
      const context = { method: req.method, path: req.path, user: res.locals.user?.approver_id, code: err.code };
      if (status >= 500 && status !== 501) logger.error({ ...context, err }, err.message);
      else logger.warn({ ...context, details: err.details }, err.message);
      send(status, { code: err.code, message: err.message, details: err.details });
      return;
    }
    if (isBodyParseError(err)) {
      send(400, { code: "validation_failed", message: "Malformed JSON body", details: {} });
      return;
    }
    logger.error({ err, method: req.method, path: req.path }, "Unhandled error");
    send(500, { code: "internal_error", message: "Internal server error", details: {} });
  };
}

/** express.json() signals bad JSON with a SyntaxError carrying `type: "entity.parse.failed"`. */
function isBodyParseError(err: unknown): boolean {
  return err instanceof SyntaxError && "type" in err && err.type === "entity.parse.failed";
}
