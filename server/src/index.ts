import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { CLIENT_DIST, DB_PATH, PORT } from "./config.ts";
import { openDb } from "./db.ts";
import { getSchemaVersion } from "./migrations.ts";

const db = openDb(DB_PATH);
console.log(`[server] database ${DB_PATH} (schema v${getSchemaVersion(db)})`);

const app = createApp({ clientDist: CLIENT_DIST });

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
  console.log(`[server] serving client from ${CLIENT_DIST}`);
});

function shutdown(signal: string): void {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
