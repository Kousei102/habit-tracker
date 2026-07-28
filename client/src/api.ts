import type {
  ErrorResponse,
  HealthResponse,
  LoginRequest,
  LogoutResponse,
  MeResponse,
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
};

async function requestJson<T>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init?.headers },
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

function postJson<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
  return requestJson<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
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

/** Habit list. The shape lands in Phase 3; Phase 2 only needs the auth check. */
export function getHabits(): Promise<unknown[]> {
  return requestJson<unknown[]>("/api/habits");
}
