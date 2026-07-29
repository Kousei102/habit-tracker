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
