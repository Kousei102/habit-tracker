import { Hono } from "hono";
import type { ErrorResponse } from "../../shared/types.ts";
import { healthRoutes } from "./routes/health.ts";
import { createClientStaticHandler } from "./static.ts";

export type AppOptions = {
  /** Directory holding the built client (client/dist). */
  clientDist: string;
};

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.route("/api", healthRoutes);

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
