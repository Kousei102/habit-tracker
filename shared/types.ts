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
