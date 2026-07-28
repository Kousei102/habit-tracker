import { Hono } from "hono";
import type { HealthResponse } from "../../../shared/types.ts";

export const healthRoutes = new Hono();

healthRoutes.get("/health", (c) => {
  const body: HealthResponse = { ok: true };
  return c.json(body);
});
