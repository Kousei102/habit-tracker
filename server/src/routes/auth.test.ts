import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ErrorResponse, MeResponse } from "../../../shared/types.ts";
import { createApp } from "../app.ts";
import { SESSION_COOKIE, hashPassword } from "../auth.ts";
import { CLIENT_DIST } from "../config.ts";
import { openDb } from "../db.ts";

const USERNAME = "e2e";
const PASSWORD = "e2e-password";

function makeApp(): { app: ReturnType<typeof createApp>; db: DatabaseSync } {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(
    USERNAME,
    hashPassword(PASSWORD),
    new Date().toISOString(),
  );
  return { app: createApp({ db, clientDist: CLIENT_DIST }), db };
}

function post(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== undefined) headers["cookie"] = cookie;
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers["cookie"] = cookie;
  return new Request(`http://localhost${path}`, { headers });
}

/** `session=<token>` ready to be sent back as a Cookie header. */
function sessionCookieOf(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header");
  const value = /(?:^|,\s*)session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(value, `expected a ${SESSION_COOKIE} cookie in ${setCookie}`);
  return `${SESSION_COOKIE}=${value}`;
}

async function loginCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.fetch(post("/api/auth/login", { username: USERNAME, password: PASSWORD }));
  assert.equal(response.status, 200);
  return sessionCookieOf(response);
}

describe("POST /api/auth/login", () => {
  it("AC-2.3: sets an HttpOnly, SameSite=Lax session cookie on success", async () => {
    const { app, db } = makeApp();

    const response = await app.fetch(post("/api/auth/login", { username: USERNAME, password: PASSWORD }));

    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`${SESSION_COOKIE}=[0-9a-f]{64}`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
    // Not production in tests, so the cookie must still work over plain http.
    assert.doesNotMatch(setCookie, /Secure/i);

    const body = (await response.json()) as MeResponse;
    assert.equal(body.user.username, USERNAME);
    assert.equal("password_hash" in body.user, false);
    db.close();
  });

  it("AC-2.4: answers identically for a wrong password and an unknown username", async () => {
    const { app, db } = makeApp();

    const wrongPassword = await app.fetch(post("/api/auth/login", { username: USERNAME, password: "nope" }));
    const unknownUser = await app.fetch(post("/api/auth/login", { username: "ghost", password: PASSWORD }));

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);

    const wrongBody = await wrongPassword.text();
    const unknownBody = await unknownUser.text();
    assert.equal(wrongBody, unknownBody);
    // ...and the shared message must not name the user or hint at what matched.
    assert.doesNotMatch(wrongBody, new RegExp(USERNAME));
    assert.doesNotMatch(wrongBody, /ghost|存在|見つかりま|not found|unknown/i);

    // A failed login must not hand out a session either.
    assert.equal(wrongPassword.headers.get("set-cookie"), null);
    assert.equal(unknownUser.headers.get("set-cookie"), null);
    db.close();
  });

  it("rejects a malformed body with 400", async () => {
    const { app, db } = makeApp();

    const missingFields = await app.fetch(post("/api/auth/login", { username: USERNAME }));
    assert.equal(missingFields.status, 400);

    const notJson = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    assert.equal(notJson.status, 400);
    db.close();
  });
});

describe("GET /api/habits", () => {
  it("AC-2.2: answers 401 without a session", async () => {
    const { app, db } = makeApp();

    const response = await app.fetch(get("/api/habits"));

    assert.equal(response.status, 401);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = (await response.json()) as ErrorResponse;
    assert.equal(typeof body.error, "string");
    db.close();
  });

  it("AC-2.2: answers 401 for a bogus or expired token too", async () => {
    const { app, db } = makeApp();

    const response = await app.fetch(get("/api/habits", `${SESSION_COOKIE}=not-a-real-token`));

    assert.equal(response.status, 401);
    db.close();
  });

  it("AC-2.2: sub-paths are behind the same auth boundary", async () => {
    const { app, db } = makeApp();

    const response = await app.fetch(get("/api/habits/1"));

    assert.equal(response.status, 401);
    db.close();
  });

  it("returns an empty list once authenticated (Phase 3 fills it in)", async () => {
    const { app, db } = makeApp();
    const cookie = await loginCookie(app);

    const response = await app.fetch(get("/api/habits", cookie));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    db.close();
  });
});

describe("GET /api/auth/me", () => {
  it("answers 401 when unauthenticated", async () => {
    const { app, db } = makeApp();

    const response = await app.fetch(get("/api/auth/me"));

    assert.equal(response.status, 401);
    db.close();
  });

  it("returns the session user when authenticated", async () => {
    const { app, db } = makeApp();
    const cookie = await loginCookie(app);

    const response = await app.fetch(get("/api/auth/me", cookie));

    assert.equal(response.status, 200);
    const body = (await response.json()) as MeResponse;
    assert.equal(body.user.username, USERNAME);
    db.close();
  });
});

describe("POST /api/auth/logout", () => {
  it("invalidates the session server-side, not just in the browser", async () => {
    const { app, db } = makeApp();
    const cookie = await loginCookie(app);

    const loggedOut = await app.fetch(post("/api/auth/logout", {}, cookie));
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers.get("set-cookie") ?? "", new RegExp(`${SESSION_COOKIE}=;`));

    // Replaying the old cookie must not work.
    const replay = await app.fetch(get("/api/auth/me", cookie));
    assert.equal(replay.status, 401);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 0);
    db.close();
  });

  it("is idempotent without a session", async () => {
    const { app, db } = makeApp();

    const response = await app.fetch(post("/api/auth/logout", {}));

    assert.equal(response.status, 200);
    db.close();
  });
});
