import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { AuthEnv } from "../auth.ts";
import { requireAuth } from "../auth.ts";

/**
 * Habits live behind authentication from the very first commit that exposes
 * them: AC-2.2 requires an unauthenticated `GET /api/habits` to answer 401.
 *
 * The listing itself is Phase 3 work. Until then an authenticated caller gets
 * an empty list — the route exists to pin the auth boundary, not the data.
 */
export function createHabitsRoutes(db: DatabaseSync): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  // `*` covers the collection and every future `/:id` below it, so a Phase 3
  // route cannot be added outside the auth boundary by accident.
  routes.use("*", requireAuth(db));

  routes.get("/", (c) => {
    return c.json([]);
  });

  return routes;
}
