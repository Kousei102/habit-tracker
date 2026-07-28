import path from "node:path";

/** Repository root: server/src -> server -> repo root. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** Where `npm run build --workspace client` puts the built SPA. */
export const CLIENT_DIST = path.join(REPO_ROOT, "client", "dist");

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

export const PORT = readPort(process.env.PORT, 3001);

/**
 * A relative DB_PATH is resolved against the current working directory (the
 * repository root when started through the npm scripts), so `DB_PATH=.harness/tmp/e2e.db`
 * lands where the caller expects.
 */
export const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH ?? "data/habits.db");

export const IS_PRODUCTION = process.env.NODE_ENV === "production";
