import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HealthResponse } from "../../shared/types.ts";
import { createApp } from "./app.ts";
import { CLIENT_DIST } from "./config.ts";

const app = createApp({ clientDist: CLIENT_DIST });

describe("GET /api/health", () => {
  it("returns 200 with {\"ok\":true}", async () => {
    const response = await app.fetch(new Request("http://localhost/api/health"));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);

    const body = (await response.json()) as HealthResponse;
    assert.deepEqual(body, { ok: true });
  });
});

describe("unknown API paths", () => {
  it("answer 404 as JSON rather than falling back to index.html", async () => {
    const response = await app.fetch(new Request("http://localhost/api/nope"));

    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  });
});
