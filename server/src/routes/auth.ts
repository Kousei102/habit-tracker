import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { ErrorResponse, LoginRequest, LogoutResponse, MeResponse } from "../../../shared/types.ts";
import type { AuthEnv } from "../auth.ts";
import {
  clearSessionCookie,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  findUserByUsername,
  readSessionCookie,
  requireAuth,
  setSessionCookie,
  verifyAgainstDummyHash,
  verifyPassword,
} from "../auth.ts";

/**
 * One message and one status for every rejected login. An unknown username and
 * a wrong password must be indistinguishable from the outside, otherwise the
 * endpoint doubles as a username oracle (AC-2.4).
 */
const INVALID_CREDENTIALS: ErrorResponse = {
  error: "ユーザー名またはパスワードが正しくありません",
};

function parseLoginBody(body: unknown): LoginRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") return null;
  return { username, password };
}

export function createAuthRoutes(db: DatabaseSync): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  routes.post("/auth/login", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      const body: ErrorResponse = { error: "リクエストの形式が不正です" };
      return c.json(body, 400);
    }

    const credentials = parseLoginBody(raw);
    if (credentials === null) {
      const body: ErrorResponse = { error: "リクエストの形式が不正です" };
      return c.json(body, 400);
    }

    const user = findUserByUsername(db, credentials.username);
    const ok =
      user === null
        ? verifyAgainstDummyHash(credentials.password)
        : verifyPassword(credentials.password, user.password_hash);

    if (!ok || user === null) {
      return c.json(INVALID_CREDENTIALS, 401);
    }

    // Cheap housekeeping on a rare request, so expired rows never accumulate.
    deleteExpiredSessions(db);

    const session = createSession(db, user.id);
    setSessionCookie(c, session);

    const body: MeResponse = { user: { id: user.id, username: user.username } };
    return c.json(body);
  });

  routes.post("/auth/logout", (c) => {
    const token = readSessionCookie(c);
    if (token !== undefined) deleteSession(db, token);
    clearSessionCookie(c);

    // Logging out is idempotent: no session is already the desired end state.
    const body: LogoutResponse = { ok: true };
    return c.json(body);
  });

  routes.get("/auth/me", requireAuth(db), (c) => {
    const body: MeResponse = { user: c.get("user") };
    return c.json(body);
  });

  return routes;
}
