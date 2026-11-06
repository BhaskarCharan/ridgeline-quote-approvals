import type { RequestHandler, Response } from "express";
import { UnauthenticatedError } from "../../domain/errors.js";
import type { Approver } from "../../domain/models.js";
import type { ReferenceData } from "../../ports/reference-data.port.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      /** The authenticated caller, set by {@link requireUser}. */
      user?: Approver;
    }
  }
}

/** Header carrying the caller's id (e.g. "S01", "U04"). */
export const USER_HEADER = "x-user-id";

/**
 * Demo authentication: trust the `X-User-Id` header and look the id up in the
 * approvers table. Missing or unknown -> 401.
 *
 * Production: the header would be replaced by the identity provider (Okta /
 * Entra ID OIDC token validated at the gateway or here), with the user id and
 * role taken from verified claims, never from a client-controlled header.
 */
export function requireUser(referenceData: ReferenceData): RequestHandler {
  return (req, res, next) => {
    const userId = req.get(USER_HEADER)?.trim();
    if (!userId) {
      throw new UnauthenticatedError("Missing X-User-Id header");
    }
    const user = referenceData.getApprover(userId);
    if (!user) {
      throw new UnauthenticatedError("Unknown user", { userId });
    }
    res.locals.user = user;
    next();
  };
}

/** The authenticated user; only valid on routes behind {@link requireUser}. */
export function currentUser(res: Response): Approver {
  const user = res.locals.user;
  if (!user) throw new UnauthenticatedError("Not authenticated");
  return user;
}
