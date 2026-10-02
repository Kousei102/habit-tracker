/**
 * The two browser features that decide whether the user's records survive.
 *
 * Neither is cosmetic. WebKit deletes localStorage after seven days of not
 * opening a site, and exempts only a web app *added to the home screen* — which
 * requires a manifest and, in practice, a service worker for the app to be
 * usable once it is there. `navigator.storage.persist()` asks the browser not to
 * evict us under storage pressure. Both are requests, not guarantees; that is
 * why the export in `data/backup.ts` exists as well.
 *
 * Everything here fails soft. A browser with no service workers, a request for
 * persistence that is denied, a registration that 404s — none of them may stop
 * the app from working, because the app works entirely without them.
 */

/**
 * The registration state, mirrored onto `<html data-sw="…">`.
 *
 *   unsupported  … no service worker API (or an insecure origin)
 *   disabled     … dev build; see below
 *   registering  … asked for, not in control yet
 *   controlled   … a worker is serving this page — the app now works offline
 *   failed       … the registration threw
 *
 * It is an attribute rather than internal state because "the worker is in
 * control" is otherwise unobservable, and the offline test (AC-8.3) has to wait
 * for exactly that moment. Racing it with a fixed timeout is how a suite starts
 * failing on slow machines only.
 */
function setState(state: string): void {
  document.documentElement.dataset["sw"] = state;
}

/** Memoised: `persist()` should be asked once per page, not once per component. */
let persistence: Promise<boolean> | null = null;

/**
 * Asks the browser to keep this origin's storage even under pressure (AC-8.4).
 *
 * Resolves to whether storage is persistent *now* — false is a perfectly normal
 * answer (Safari grants it on its own criteria, and a denied request is not an
 * error), so nothing here throws and nothing branches on it except the line in
 * the backup panel that tells the user where they stand.
 */
export function requestPersistentStorage(): Promise<boolean> {
  if (persistence !== null) return persistence;

  persistence = (async () => {
    try {
      const manager = navigator.storage;
      if (manager === undefined || typeof manager.persist !== "function") return false;

      // Asking again when it has already been granted would re-prompt on some
      // browsers for no gain.
      if (typeof manager.persisted === "function" && (await manager.persisted())) return true;

      return await manager.persist();
    } catch (cause) {
      console.warn("[pwa] persistent storage was not granted:", cause);
      return false;
    }
  })();

  return persistence;
}

// ---------------------------------------------------------------------------
// The app icon badge (Phase 9)
// ---------------------------------------------------------------------------

/**
 * `navigator` with the two Badging API methods, which TypeScript's DOM lib does
 * not declare. Optional because most browsers do not have them: this is a
 * capability check, not a cast that pretends they are there.
 */
type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Whether this browser can put a number on the app icon.
 *
 * Read by the panel to say "this device does not support it" instead of offering
 * a button that would do nothing. Note that support is not permission: iOS has
 * the API and still refuses to draw anything until notifications are allowed.
 */
export function supportsBadge(): boolean {
  return typeof (navigator as BadgeNavigator).setAppBadge === "function";
}

/**
 * Puts `count` on the app icon, or clears it at zero.
 *
 * Fire-and-forget on purpose: the caller is a React effect reacting to a changed
 * count, and there is nothing it could do with a rejection. Both methods reject
 * when the app is not installed or the permission is missing, which is the normal
 * case in a plain browser tab — so a swallowed rejection here is expected
 * behaviour and not a bug being hidden. What must never happen is an unhandled
 * rejection reaching the page (AC-9.7, AC-9.8).
 */
export function setBadge(count: number): void {
  const nav = navigator as BadgeNavigator;

  try {
    if (count <= 0) {
      // `setAppBadge(0)` is specified to clear as well, but `clearAppBadge` is
      // the one that is present on every implementation that ships either.
      void nav.clearAppBadge?.()?.catch(() => undefined);
      return;
    }

    void nav.setAppBadge?.(count)?.catch(() => undefined);
  } catch (cause) {
    // A synchronous throw is out of spec, but a badge is a nicety and the app
    // behind it is not.
    console.warn("[pwa] the app badge could not be updated:", cause);
  }
}

/** The permission states, without depending on the DOM lib's enum spelling. */
export type BadgePermission = "default" | "granted" | "denied" | "unsupported";

/** What the browser says right now, without asking the user anything. */
export function notificationPermission(): BadgePermission {
  if (typeof Notification === "undefined") return "unsupported";

  const current = Notification.permission;
  if (current === "granted" || current === "denied") return current;
  return "default";
}

/**
 * Asks for the notification permission the badge needs on iOS.
 *
 * **Must be called from a user gesture.** Safari rejects (and Chrome warns) when
 * `requestPermission()` is not driven by a click, which is why nothing in
 * `initPwa()` calls this and the panel puts it behind an explicit button.
 *
 * The app does not send notifications — there is no server to send them from
 * (docs/phases.md, Phase 9). The permission is required because WebKit ties the
 * Badging API to it: a number on the home-screen icon is a notification as far as
 * iOS is concerned.
 */
export async function requestNotificationPermission(): Promise<BadgePermission> {
  const current = notificationPermission();
  // Already answered, either way. Asking again cannot change a denial — only the
  // user can, in the browser's own settings — and re-prompting a granted origin
  // is a prompt for nothing.
  if (current !== "default") return current;

  try {
    const result = await Notification.requestPermission();
    return result === "granted" || result === "denied" ? result : "default";
  } catch (cause) {
    console.warn("[pwa] the notification permission could not be requested:", cause);
    return "denied";
  }
}

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    setState("unsupported");
    return;
  }

  setState(navigator.serviceWorker.controller === null ? "registering" : "controlled");
  navigator.serviceWorker.addEventListener("controllerchange", () => setState("controlled"));

  const base = import.meta.env.BASE_URL;

  try {
    // `updateViaCache: "none"` so the worker script itself is always revalidated
    // against the server. A worker that can be served from the HTTP cache is a
    // worker that can pin an old app in place for as long as that cache lasts.
    await navigator.serviceWorker.register(`${base}sw.js`, { scope: base, updateViaCache: "none" });

    // Resolves once a worker is active, which — because `install` awaits the
    // precache — also means the app shell is on disk.
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller !== null) setState("controlled");
  } catch (cause) {
    // Not fatal: without a worker the app still runs, it just stops working
    // offline. Saying so out loud beats a silent downgrade.
    console.error("[pwa] the service worker could not be registered:", cause);
    setState("failed");
  }
}

/**
 * Removes any worker left over from a production build served on this origin.
 *
 * Only runs in dev. Without it, opening the dev server on a port that once
 * served `dist` gives you an app that ignores every edit you make — the single
 * most common way a service worker wastes an afternoon.
 */
async function unregisterServiceWorkers(): Promise<void> {
  setState("disabled");
  if (!("serviceWorker" in navigator)) return;

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if (registrations.length > 0) {
      console.warn("[pwa] unregistered a leftover service worker (dev build)");
    }
  } catch (cause) {
    console.warn("[pwa] could not unregister a service worker:", cause);
  }
}

/** Called once, from main.tsx, before React renders. Never awaited. */
export function initPwa(): void {
  void requestPersistentStorage();
  void (import.meta.env.PROD ? registerServiceWorker() : unregisterServiceWorkers());
}
