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

/**
 * How a habit is recorded.
 *
 * A union of string literals rather than an `enum`: the server runs .ts files
 * through Node's type stripping, where `enum` would need codegen.
 */
export type HabitKind = "boolean" | "numeric";

/**
 * A habit as it crosses the wire. `user_id` is deliberately absent — the server
 * scopes every query by the session's user, so the client never needs it.
 *
 * Field names match the columns (snake_case) so that a row can be handed to the
 * client without a renaming layer that could silently drop a field.
 */
export type Habit = {
  id: number;
  name: string;
  kind: HabitKind;
  /** `numeric` only: the daily goal. Always null for `boolean`. */
  target: number | null;
  /** `numeric` only: '分', '回', … Always null for `boolean`. */
  unit: string | null;
  /** Palette key used by the heatmap. */
  color: string;
  sort_order: number;
  /** Set when the habit is archived (logical delete). Listed habits have null. */
  archived_at: string | null;
  created_at: string;
};

/** One day's record for one habit. `date` is always `YYYY-MM-DD`. */
export type Entry = {
  habit_id: number;
  date: string;
  /** `boolean` habits store 0/1; `numeric` habits store the amount done. */
  value: number;
  updated_at: string;
};

/** Request body of `POST /api/habits`. */
export type CreateHabitRequest = {
  name: string;
  kind: HabitKind;
  /** Required for `numeric`, ignored (stored as null) for `boolean`. */
  target?: number | null;
  unit?: string | null;
  color?: string;
};

/**
 * Request body of `PATCH /api/habits/:id`. Every field is optional; omitted
 * fields keep their stored value. `kind` cannot be changed.
 */
export type UpdateHabitRequest = {
  name?: string;
  target?: number | null;
  unit?: string | null;
  color?: string;
};

/** Request body of `PUT /api/entries/:habitId/:date`. */
export type PutEntryRequest = {
  value: number;
};

/** Response body of `DELETE /api/habits/:id`. */
export type DeleteHabitResponse = {
  ok: boolean;
};
