/**
 * Types shared by client and server. Imported with a relative path and a real
 * ".ts" extension from both sides — there is no build step for this directory.
 */

/** Response body of `GET /api/health`. */
export type HealthResponse = {
  ok: boolean;
};

/** Error body used by every API route that fails. */
export type ErrorResponse = {
  error: string;
};

/**
 * The authenticated user as the client is allowed to see it. Deliberately does
 * not carry `password_hash` — this type is what crosses the wire.
 */
export type SessionUser = {
  id: number;
  username: string;
};

/** Request body of `POST /api/auth/login`. */
export type LoginRequest = {
  username: string;
  password: string;
};

/** Response body of `POST /api/auth/login` and `GET /api/auth/me`. */
export type MeResponse = {
  user: SessionUser;
};

/** Response body of `POST /api/auth/logout`. */
export type LogoutResponse = {
  ok: boolean;
};
