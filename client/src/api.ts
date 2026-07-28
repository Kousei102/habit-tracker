import type { ErrorResponse, HealthResponse } from "../../shared/types.ts";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
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
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health");
}
