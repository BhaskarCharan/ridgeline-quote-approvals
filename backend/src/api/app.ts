import cors from "cors";
import express, { type Express } from "express";
import type { Logger } from "pino";
import { NotFoundError } from "../domain/errors.js";
import type { Clock } from "../ports/clock.js";
import type { ReferenceData } from "../ports/reference-data.port.js";
import type { QuoteProcessor } from "../services/quote-processor.js";
import type { QuoteReviewService } from "../services/review.service.js";
import { createErrorHandler } from "./error-handler.js";
import { requireUser } from "./middleware/auth.js";
import { draftsRouter } from "./routes/drafts.routes.js";
import { quotesRouter } from "./routes/quotes.routes.js";

/** What the HTTP layer needs; built in container.ts (or by tests with fakes). */
export interface AppDeps {
  clock: Clock;
  logger: Logger;
  corsOrigin: string;
  referenceData: ReferenceData;
  review: QuoteReviewService;
  processor: QuoteProcessor;
}

/**
 * Build the Express app without listening. Kept separate from server.ts so
 * supertest can exercise the real app, wired with test doubles, in-process.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: deps.corsOrigin,
      allowedHeaders: ["Content-Type", "X-User-Id"],
      methods: ["GET", "POST", "PATCH"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  /** Liveness probe (unauthenticated). Reports "now" so a frozen APP_NOW is visible. */
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", now: deps.clock.now().toISOString() });
  });

  const auth = requireUser(deps.referenceData);
  app.use("/quotes", auth, quotesRouter(deps.review));
  app.use("/drafts", auth, draftsRouter(deps.processor));

  app.use((req) => {
    throw new NotFoundError("Route not found", { method: req.method, path: req.path });
  });
  app.use(createErrorHandler(deps.logger));
  return app;
}

