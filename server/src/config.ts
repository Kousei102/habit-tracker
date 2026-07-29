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

/**
 * How the `Secure` flag on the session cookie is decided.
 *
 *   auto  … from the scheme the request actually arrived over (the default)
 *   true  … always set it
 *   false … never set it
 *
 * `auto` is right almost everywhere, because `Secure` is a statement about the
 * *connection*, not about the build: a Secure cookie sent over plain http is
 * dropped by the browser, and a non-Secure one sent over https is a leak. The
 * two overrides exist for deployments whose proxy neither terminates TLS itself
 * nor forwards `X-Forwarded-Proto` honestly.
 */
export type CookieSecureMode = "auto" | "true" | "false";

function readCookieSecure(raw: string | undefined): CookieSecureMode {
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "true" || raw === "false") return raw;
  throw new Error(`COOKIE_SECURE must be one of auto / true / false, got ${JSON.stringify(raw)}`);
}

export const COOKIE_SECURE: CookieSecureMode = readCookieSecure(process.env.COOKIE_SECURE);
