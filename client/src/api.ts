import type {
  CreateHabitRequest,
  DeleteHabitResponse,
  Entry,
  Habit,
  HealthResponse,
  LoginRequest,
  LogoutResponse,
  MeResponse,
  PutEntryRequest,
  StatsResponse,
  UpdateHabitRequest,
} from "../../shared/types.ts";
import { ApiError, NETWORK_ERROR, fallbackMessage, messageFromBody } from "./errors.ts";

/**
 * Every failure leaves this module as an `ApiError` carrying a readable Japanese
 * message (AC-6.4): a rejected fetch, a 500 with an HTML body from a proxy and a
 * 404 with a JSON body all arrive at the UI in the same shape, so no component
 * has to guess how to word one.
 */
export { ApiError };

/**
 * Called whenever the API answers 401. The session can die at any moment (it
 * expires, or `seed-user` was re-run), and every screen would otherwise have to
 * notice that on its own. Registering it once here means any request can send
 * the app back to the login screen.
 */
type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

type RequestOptions = {
  /**
   * Login is the one request where a 401 is an expected answer to be shown in
   * place, not a sign that the current session died.
   */
  notifyUnauthorized?: boolean;
  /**
   * Ask the browser to finish the request even if the page navigates away.
   * Recording a habit is a fire-and-forget write that a user may follow with an
   * immediate reload; without this, the tick they just made could be lost.
   */
  keepalive?: boolean;
};

async function requestJson<T>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> {
  // Built through `Headers` and merged *after* `...init`, because spreading the
  // init last used to overwrite this object wholesale: every request with a body
  // (login, POST, PATCH, PUT) sets `Content-Type` and silently lost the default
  // `Accept`. Headers also normalises the array/Headers forms of HeadersInit,
  // which a plain object spread would quietly turn into `{}`.
  const headers = new Headers({ Accept: "application/json" });
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      keepalive: options?.keepalive ?? false,
      ...init,
      headers,
    });
  } catch (cause) {
    // The server is down, the machine is offline, the request was cut off. There
    // is no status and no body — but the screen still has to say something, and
    // "TypeError: Failed to fetch" is not it.
    console.error(`[client] ${path} could not be reached:`, cause);
    throw new ApiError(NETWORK_ERROR, fallbackMessage(NETWORK_ERROR));
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON error body (a proxy's HTML page, an empty 502) carries
      // nothing worth showing; the status does.
    }

    if (response.status === 401 && options?.notifyUnauthorized !== false) {
      unauthorizedHandler?.();
    }

    throw new ApiError(response.status, messageFromBody(body) ?? fallbackMessage(response.status));
  }

  try {
    return (await response.json()) as T;
  } catch {
    // A 200 that is not the JSON we asked for — the SPA fallback answering an
    // API path, say. Silently treating it as data is how a screen ends up
    // rendering nothing with no explanation.
    throw new ApiError(response.status, "サーバーの応答を読み取れませんでした");
  }
}

function sendJson<T>(method: string, path: string, body: unknown, options?: RequestOptions): Promise<T> {
  return requestJson<T>(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
}

function postJson<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
  return sendJson<T>("POST", path, body, options);
}

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health");
}

export function login(credentials: LoginRequest): Promise<MeResponse> {
  return postJson<MeResponse>("/api/auth/login", credentials, { notifyUnauthorized: false });
}

export function logout(): Promise<LogoutResponse> {
  return postJson<LogoutResponse>("/api/auth/logout", {});
}

/** Current session. Throws `ApiError(401)` when signed out. */
export function getMe(): Promise<MeResponse> {
  return requestJson<MeResponse>("/api/auth/me");
}

/**
 * The habits of the signed-in user, in display order.
 *
 * `includeArchived` additionally returns the deleted ones (active first). The
 * heatmap asks for them: their entries are kept on purpose, and without their
 * names that history would be undrawable.
 */
export function getHabits(includeArchived: boolean = false): Promise<Habit[]> {
  return requestJson<Habit[]>(includeArchived ? "/api/habits?include_archived=1" : "/api/habits");
}

export function createHabit(input: CreateHabitRequest): Promise<Habit> {
  return postJson<Habit>("/api/habits", input);
}

export function updateHabit(id: number, patch: UpdateHabitRequest): Promise<Habit> {
  return sendJson<Habit>("PATCH", `/api/habits/${id}`, patch);
}

/** Archives the habit. Its entries are kept — this is a logical delete. */
export function deleteHabit(id: number): Promise<DeleteHabitResponse> {
  return requestJson<DeleteHabitResponse>(`/api/habits/${id}`, { method: "DELETE" });
}

/** Undo of the above: the habit is listed again, with the records it kept. */
export function restoreHabit(id: number): Promise<Habit> {
  return postJson<Habit>(`/api/habits/${id}/restore`, {});
}

/**
 * Records within an inclusive date range. Both bounds are `YYYY-MM-DD` strings
 * decided by the client — the server never asks its own clock what day it is.
 */
export function getEntries(from: string, to: string): Promise<Entry[]> {
  const query = new URLSearchParams({ from, to });
  return requestJson<Entry[]>(`/api/entries?${query.toString()}`);
}

/** Upserts one day's value for one habit. */
export function putEntry(habitId: number, date: string, value: number): Promise<Entry> {
  const body: PutEntryRequest = { value };
  return sendJson<Entry>("PUT", `/api/entries/${habitId}/${date}`, body, { keepalive: true });
}

/**
 * Streaks and the 30 day achievement rate, as of `today` (`YYYY-MM-DD`).
 *
 * The day is a required parameter, not something the server works out: an
 * unfinished today is treated differently from a missed one, so which day it is
 * has to come from the browser that knows.
 */
export function getStats(today: string): Promise<StatsResponse> {
  const query = new URLSearchParams({ today });
  return requestJson<StatsResponse>(`/api/stats?${query.toString()}`);
}
