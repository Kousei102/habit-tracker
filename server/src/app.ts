import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { ErrorResponse } from "../../shared/types.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { createEntriesRoutes } from "./routes/entries.ts";
import { createHabitsRoutes } from "./routes/habits.ts";
import { createStatsRoutes } from "./routes/stats.ts";
import { createClientStaticHandler } from "./static.ts";

export type AppOptions = {
  /** Open database handle; routes never open their own connection. */
  db: DatabaseSync;
  /** Directory holding the built client (client/dist). */
  clientDist: string;
};

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.route("/api", healthRoutes);
  app.route("/api", createAuthRoutes(options.db));
  app.route("/api/habits", createHabitsRoutes(options.db));
  app.route("/api/entries", createEntriesRoutes(options.db));
  app.route("/api/stats", createStatsRoutes(options.db));

  // Unknown API paths answer with JSON, never with the SPA's index.html —
  // a fetch() that silently receives HTML is painful to debug.
  app.all("/api/*", (c) => {
    const body: ErrorResponse = { error: "Not Found" };
    return c.json(body, 404);
  });

  const serveClient = createClientStaticHandler(options.clientDist);
  app.get("*", serveClient);

  app.onError((error, c) => {
    console.error("[server] unhandled error:", error);
    const body: ErrorResponse = { error: "Internal Server Error" };
    return c.json(body, 500);
  });

  return app;
}
