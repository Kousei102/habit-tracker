import type {
  CreateHabitRequest,
  DeleteHabitResponse,
  Entry,
  ErrorResponse,
  Habit,
  HealthResponse,
  LoginRequest,
  LogoutResponse,
  MeResponse,
  PutEntryRequest,
  UpdateHabitRequest,
} from "../../shared/types.ts";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

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
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init?.headers },
    keepalive: options?.keepalive ?? false,
    ...init,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as ErrorResponse;
      if (typeof body.error === "string" && body.error !== "") message = body.error;
    } catch {
      // Non-JSON error body: keep the status line as the message.
    }

    if (response.status === 401 && options?.notifyUnauthorized !== false) {
      unauthorizedHandler?.();
    }

    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
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

/** The active (non-archived) habits of the signed-in user, in display order. */
export function getHabits(): Promise<Habit[]> {
  return requestJson<Habit[]>("/api/habits");
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
