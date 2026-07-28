import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ErrorResponse, SessionUser } from "../../shared/types.ts";
import { IS_PRODUCTION } from "./config.ts";

/**
 * Password hashing and session handling.
 *
 * Hashing is `node:crypto`'s scrypt — no bcrypt/argon2 dependency. The stored
 * format is `"<salt hex>:<key hex>"` (see docs/design.md), so the plaintext
 * password never touches the database (AC-2.5).
 */

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Name of the session cookie. */
export const SESSION_COOKIE = "session";

/** Session lifetime: 30 days (docs/design.md). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

/**
 * Compares a candidate password against a stored `"salt:hash"` string.
 *
 * The comparison uses `timingSafeEqual` so a wrong password cannot be narrowed
 * down byte by byte from how long the answer took. Malformed stored values
 * return false rather than throwing — a corrupt row must not 500 the login.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const separator = stored.indexOf(":");
  if (separator <= 0) return false;

  const salt = Buffer.from(stored.slice(0, separator), "hex");
  const expected = Buffer.from(stored.slice(separator + 1), "hex");
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * A throwaway hash used to burn the same scrypt work when the username does not
 * exist. Without it, "unknown user" answers measurably faster than "wrong
 * password" and the endpoint leaks which usernames are real (AC-2.4).
 */
let dummyHash: string | undefined;

export function verifyAgainstDummyHash(password: string): false {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  verifyPassword(password, dummyHash);
  return false;
}

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
};

export function findUserByUsername(db: DatabaseSync, username: string): UserRow | null {
  const row = db
    .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
    .get(username) as UserRow | undefined;
  return row ?? null;
}

export type CreatedSession = {
  token: string;
  expiresAt: string;
};

/**
 * Issues a session token for a user.
 *
 * `now` is injectable so tests can produce an already-expired session; nothing
 * in the product passes it. Session expiry is a wall-clock timestamp, which is
 * unrelated to the "the client owns what day it is" rule — that rule is about
 * habit *dates*, and a client-supplied expiry would simply be a security hole.
 */
export function createSession(db: DatabaseSync, userId: number, now: Date = new Date()): CreatedSession {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expiresAt);

  return { token, expiresAt };
}

/** Resolves a session token to its user, or null when missing or expired. */
export function findSessionUser(db: DatabaseSync, token: string, now: Date = new Date()): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id AS id, u.username AS username
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, now.toISOString()) as SessionUser | undefined;

  return row ?? null;
}

export function deleteSession(db: DatabaseSync, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/** Drops every session of a user — used when the password changes. */
export function deleteSessionsForUser(db: DatabaseSync, userId: number): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function deleteExpiredSessions(db: DatabaseSync, now: Date = new Date()): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
}

/**
 * Cookie flags: `HttpOnly` keeps the token away from scripts (AC-2.3),
 * `SameSite=Lax` blocks cross-site POSTs while keeping normal navigation
 * working, and `Secure` is production-only because dev and E2E run over plain
 * http on localhost.
 */
function cookieOptions(): { httpOnly: true; sameSite: "Lax"; path: "/"; secure: boolean } {
  return { httpOnly: true, sameSite: "Lax", path: "/", secure: IS_PRODUCTION };
}

type AnyContext = Parameters<MiddlewareHandler>[0];

export function setSessionCookie(c: AnyContext, session: CreatedSession): void {
  setCookie(c, SESSION_COOKIE, session.token, {
    ...cookieOptions(),
    expires: new Date(session.expiresAt),
  });
}

export function clearSessionCookie(c: AnyContext): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions());
}

export function readSessionCookie(c: AnyContext): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

/** Hono `Variables` contributed by `requireAuth`. */
export type AuthVariables = {
  user: SessionUser;
};

export type AuthEnv = {
  Variables: AuthVariables;
};

/**
 * Rejects unauthenticated requests with 401 and otherwise puts the user on the
 * context, so downstream handlers can scope every query by `user_id`.
 */
export function requireAuth(db: DatabaseSync): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = readSessionCookie(c);
    const user = token === undefined ? null : findSessionUser(db, token);

    if (user === null) {
      // A token that no longer resolves is dead weight in the browser.
      if (token !== undefined) clearSessionCookie(c);
      const body: ErrorResponse = { error: "認証が必要です" };
      return c.json(body, 401);
    }

    c.set("user", user);
    await next();
    return;
  };
}
