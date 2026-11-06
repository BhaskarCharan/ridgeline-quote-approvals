import { createApp } from "./api/app.js";
import { loadEnv } from "./config/env.js";
import { createContainer } from "./container.js";

/** HTTP entry point: load config, wire dependencies, listen, shut down cleanly. */
async function main(): Promise<void> {
  const container = await createContainer(loadEnv());
  const { env, logger, clock, referenceData, review, processor } = container;

  const app = createApp({ clock, logger, corsOrigin: env.CORS_ORIGIN, referenceData, review, processor });
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "Ridgeline quote approvals API listening");
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "Shutting down");
    server.close(() => {
      void container.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
