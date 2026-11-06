import cors from "cors";
import express, { type Express } from "express";
import type { Logger } from "pino";
import { NotFoundError } from "../domain/errors.js";
import type { Clock } from "../ports/clock.js";
import { createErrorHandler } from "./error-handler.js";

/** What the HTTP layer needs. Grows as routes are added; built in container.ts. */
export interface AppDeps {
  clock: Clock;
  logger: Logger;
  corsOrigin: string;
}

/**
 * Build the Express app without listening. Kept separate from server.ts so
 * supertest can exercise the real app, wired with test doubles, in-process.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: deps.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));

  /** Liveness probe. Reports the service's notion of "now" so a frozen APP_NOW is visible. */
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", now: deps.clock.now().toISOString() });
  });

  app.use((req) => {
    throw new NotFoundError("Route not found", { method: req.method, path: req.path });
  });
  app.use(createErrorHandler(deps.logger));
  return app;
}
