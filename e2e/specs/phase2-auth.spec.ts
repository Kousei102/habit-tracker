import {
  CREDENTIALS,
  SESSION_COOKIE,
  dashboardHeading,
  expect,
  loginButton,
  loginError,
  loginHeading,
  logoutButton,
  passwordField,
  submitLogin,
  test,
  usernameField,
} from "../fixtures.ts";
import type { Page } from "@playwright/test";

// Phase 2 acceptance criteria under test here:
//
//   AC-2.2 Unauthenticated `GET /api/habits` answers 401.
//   AC-2.3 A correct `POST /api/auth/login` issues an HttpOnly, SameSite=Lax cookie.
//   AC-2.4 A wrong password answers 401 and the body does not leak whether the
//          username exists.
//   AC-2.6 [E2E] Opening `/` unauthenticated shows the login screen.
//   AC-2.7 [E2E] Signing in shows the dashboard, and a reload stays signed in.
//   AC-2.8 [E2E] Signing out returns to the login screen, and a reload after that
//          does not show the dashboard.
//
// AC-2.1 (seed script) and AC-2.5 (no plaintext in `users.password_hash`) are
// verified outside the browser; see the review file.
//
// Written against the AC, not the markup: everything is located by role and
// accessible name.

const LOGIN_PATH = "/api/auth/login";
const HABITS_PATH = "/api/habits";
const ME_PATH = "/api/auth/me";

/**
 * Asserts the login screen — and only the login screen — is on display.
 * The positive half runs first so the negative half can never pass vacuously
 * against a page that failed to render at all.
 */
async function expectLoginScreen(page: Page): Promise<void> {
  await expect(loginHeading(page)).toBeVisible();
  await expect(usernameField(page)).toBeVisible();
  await expect(passwordField(page)).toBeVisible();
  await expect(loginButton(page)).toBeVisible();
  await expect(dashboardHeading(page)).toHaveCount(0);
  await expect(logoutButton(page)).toHaveCount(0);
}

/** Asserts the signed-in screen — and only it — is on display. */
async function expectDashboard(page: Page): Promise<void> {
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(logoutButton(page)).toBeVisible();
  await expect(loginButton(page)).toHaveCount(0);
  await expect(passwordField(page)).toHaveCount(0);
}

test.describe("Phase 2 — authentication", () => {
  test("AC-2.2: GET /api/habits answers 401 without a session", async ({ request }) => {
    // The `request` fixture has its own empty cookie jar, so this really is
    // an unauthenticated call.
    const response = await request.get(HABITS_PATH);

    expect(response.status()).toBe(401);
    expect(response.headers()["content-type"] ?? "").toMatch(/application\/json/);
    // A 401 that still hands back habit data would defeat the point.
    expect(await response.text()).not.toMatch(/\[/);
  });

  test("AC-2.2: an invented session cookie does not get past the boundary", async ({ request }) => {
    const response = await request.get(HABITS_PATH, {
      headers: { cookie: `${SESSION_COOKIE}=0123456789abcdef0123456789abcdef` },
    });

    expect(response.status()).toBe(401);
  });

  test("AC-2.3: a correct login issues an HttpOnly, SameSite=Lax session cookie", async ({ page, context }) => {
    await page.goto("/");
    await expect(loginHeading(page)).toBeVisible();

    const loginResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === LOGIN_PATH && r.request().method() === "POST",
    );
    await submitLogin(page);

    const response = await loginResponse;
    expect(response.status()).toBe(200);

    // The wire form of the cookie: the attributes the AC names must be present.
    const setCookieHeaders = (await response.headersArray())
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => h.value);
    const sessionHeader = setCookieHeaders.find((v) => v.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionHeader, `expected a ${SESSION_COOKIE} cookie in ${JSON.stringify(setCookieHeaders)}`).toBeDefined();
    expect(sessionHeader ?? "").toMatch(/;\s*HttpOnly/i);
    expect(sessionHeader ?? "").toMatch(/;\s*SameSite=Lax/i);

    // ...and the browser's own view of it agrees.
    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie, "the browser did not store the session cookie").toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.value ?? "").not.toBe("");

    // HttpOnly is only meaningful if script really cannot read it.
    const scriptVisible = await page.evaluate(() => document.cookie);
    expect(scriptVisible).not.toContain(SESSION_COOKIE);

    // The response body must not carry the credential material back out.
    const body = await response.text();
    expect(body).not.toContain(CREDENTIALS.password);
    expect(body).not.toContain("password_hash");
  });

  test("AC-2.4: a wrong password and an unknown username are indistinguishable", async ({ request }) => {
    const wrongPassword = await request.post(LOGIN_PATH, {
      data: { username: CREDENTIALS.username, password: "definitely-not-the-password" },
    });
    const unknownUser = await request.post(LOGIN_PATH, {
      data: { username: "no-such-person", password: CREDENTIALS.password },
    });

    expect(wrongPassword.status()).toBe(401);
    expect(unknownUser.status()).toBe(401);

    const wrongBody = await wrongPassword.text();
    const unknownBody = await unknownUser.text();
    // Byte-identical bodies: anything else is a username oracle.
    expect(wrongBody).toBe(unknownBody);
    expect(wrongBody).not.toContain(CREDENTIALS.username);
    expect(wrongBody).not.toContain("no-such-person");

    // A rejected login must not hand out a session either.
    for (const response of [wrongPassword, unknownUser]) {
      const setCookie = (await response.headersArray())
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value)
        .join("\n");
      expect(setCookie).not.toMatch(new RegExp(`${SESSION_COOKIE}=\\w`));
    }
  });

  test("AC-2.4: the login screen rejects a wrong password without signing in", async ({ page, context }) => {
    await page.goto("/");
    await expectLoginScreen(page);

    await submitLogin(page, { username: CREDENTIALS.username, password: "definitely-not-the-password" });

    // A visible, readable failure...
    await expect(loginError(page)).toBeVisible();
    await expect(loginError(page)).not.toHaveText("");
    // ...that does not confirm the username exists.
    await expect(loginError(page)).not.toHaveText(new RegExp(CREDENTIALS.username));

    // ...and no sign-in happened, on screen or in the cookie jar.
    await expectLoginScreen(page);
    expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)?.value ?? "").toBe("");

    // Reloading must not produce a session out of thin air either.
    await page.reload();
    await expectLoginScreen(page);
  });

  test("AC-2.6: opening / unauthenticated shows the login screen", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    await expectLoginScreen(page);
  });

  test("AC-2.6 / AC-1.7 regression: the login screen still reports server health", async ({ page }) => {
    await page.goto("/");
    await expectLoginScreen(page);

    // Phase 1's readout must survive Phase 2's new screen (AC-1.7), and stay a
    // single `status` region so the Phase 1 spec keeps addressing it by role.
    await expect(page.getByRole("status")).toHaveCount(1);
    await expect(page.getByRole("status")).toHaveText(/ok/i);
  });

  test("AC-2.7: signing in shows the dashboard and survives a reload", async ({ page }) => {
    await page.goto("/");
    await expectLoginScreen(page);

    await submitLogin(page);
    await expectDashboard(page);
    await expect(page.getByText(CREDENTIALS.username)).toBeVisible();

    // The reload must re-establish the session from the server, not from a
    // client-side leftover: the app has to ask, and be told yes.
    const meResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === ME_PATH && r.request().method() === "GET",
    );
    await page.reload();
    expect((await meResponse).status()).toBe(200);

    await expectDashboard(page);

    // A second reload is not special, but it catches a session consumed on use.
    await page.reload();
    await expectDashboard(page);
  });

  test("AC-2.7: the signed-in state is carried by the session cookie", async ({ page, context }) => {
    await page.goto("/");
    await submitLogin(page);
    await expectDashboard(page);

    // Drop the cookie the way an expiry would, and the dashboard must go with it.
    // If this still shows the dashboard, "logged in" is being remembered
    // somewhere the server cannot revoke.
    await context.clearCookies();
    await page.reload();
    await expectLoginScreen(page);
  });

  test("AC-2.7: an authenticated GET /api/habits succeeds from the signed-in page", async ({ loggedInPage }) => {
    // `page.request` shares the browser context's cookie jar, so this is the
    // same session the user is looking at.
    const response = await loggedInPage.request.get(HABITS_PATH);

    expect(response.status()).toBe(200);
  });

  test("AC-2.8: signing out returns to the login screen and stays there", async ({ loggedInPage, context }) => {
    const page = loggedInPage;

    await logoutButton(page).click();
    await expectLoginScreen(page);

    // Reloading after logout must not resurrect the dashboard.
    await page.reload();
    await expectLoginScreen(page);

    // Navigating to / afresh must not either.
    await page.goto("/");
    await expectLoginScreen(page);

    // And the browser is no longer holding a usable session cookie.
    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.value ?? "").toBe("");
  });

  test("AC-2.8: the session is invalidated on the server, not just in the browser", async ({ page, context }) => {
    await page.goto("/");
    await submitLogin(page);
    await expectDashboard(page);

    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    const token = cookie?.value ?? "";
    expect(token).not.toBe("");

    await logoutButton(page).click();
    await expectLoginScreen(page);

    // Replaying the token a browser could have kept must not work: logout that
    // only clears the cookie leaves a valid token in anyone's hands.
    const replay = await page.request.get(ME_PATH, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(replay.status()).toBe(401);

    const replayHabits = await page.request.get(HABITS_PATH, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(replayHabits.status()).toBe(401);
  });

  test("AC-2.8: a stale session cookie lands on the login screen, not the dashboard", async ({ page, context }) => {
    await page.goto("/");
    await submitLogin(page);
    await expectDashboard(page);

    // Simulate the session dying server-side while the tab is open by replacing
    // the token with one the server has never issued.
    const original = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(original).toBeDefined();
    await context.clearCookies();
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        domain: original?.domain ?? "localhost",
        path: "/",
        httpOnly: true,
        secure: original?.secure ?? false,
        sameSite: "Lax",
      },
    ]);

    await page.reload();
    await expectLoginScreen(page);
  });
});
