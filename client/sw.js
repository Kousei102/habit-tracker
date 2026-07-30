/// <reference lib="webworker" />
/*
 * The service worker.
 *
 * Hand written, and not `vite-plugin-pwa`, for the same reason there is no
 * SQLite driver, no bcrypt and no chart library in this repository: the whole
 * behaviour is ~60 lines, and a generated worker is a thing you cannot read when
 * it is the reason your users see last week's app. The precache list and the
 * cache name are injected at build time by the `service-worker` plugin in
 * client/vite.config.ts, which is the only part that has to know the hashed
 * filenames.
 *
 * ---------------------------------------------------------------------------
 * The strategy, and the accident it is chosen to avoid
 * ---------------------------------------------------------------------------
 *
 * The failure mode of a home-made service worker is that an old worker serves an
 * old `index.html` from its cache forever, and no deploy can ever reach the
 * user again. Four things prevent it here:
 *
 *  1. **Navigations are network first.** Online, the browser always gets the
 *     HTML the server currently has; the cache is only consulted when the
 *     network refuses. A stale shell can therefore never outlive one online
 *     load.
 *  2. **Everything else is cache first, but only ever content-addressed.** Vite
 *     puts a content hash in every asset filename, so a cached
 *     `index-a1b2c3.js` is immutable by construction — the new build asks for a
 *     different name.
 *  3. **The cache name contains a hash of the whole build.** A new build is a
 *     new cache, and `activate` deletes every other cache this app owns. There
 *     is no path by which two builds' files mix.
 *  4. **The precache fetches bypass the HTTP cache** (`cache: "reload"`).
 *     Otherwise the first install could copy a stale `index.html` *out of the
 *     browser's own cache* and into a cache that outlives it, which is the same
 *     accident one layer down.
 *
 * `skipWaiting` + `clients.claim` mean the new worker takes over as soon as it
 * has finished precaching. That is safe here because the app is a single bundle
 * with no lazily loaded chunks: an open page never asks for a file that the new
 * cache does not have. The page itself is not reloaded from under the user —
 * the update simply arrives on their next load.
 */

const BUILD = self.__HABIT_TRACKER_BUILD__ ?? { version: "dev", shell: "./index.html", precache: [] };

const CACHE_PREFIX = "habit-tracker-";
const CACHE_NAME = CACHE_PREFIX + BUILD.version;
const SHELL = new URL(BUILD.shell, self.location.href).toString();

/**
 * How every lookup in this file is done, and it is not the default.
 *
 * `Cache.match` honours the stored response's `Vary` header, and static hosts
 * routinely send `Vary: Origin` (Vite's own preview server does). The precache
 * entries are fetched by the worker, which sends no `Origin`; the page's own
 * requests for the same files — a module script is a CORS request — do. Under
 * the default rules those are different entries, so every asset misses the cache
 * and the app is blank the moment it is offline, while the cache looks perfectly
 * populated in devtools.
 *
 * Ignoring `Vary` is safe here precisely because these URLs are content
 * addressed: there is only ever one representation of `index-a1b2c3.js`.
 */
const MATCH = { ignoreVary: true };

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `cache: "reload"` on every request: see (4) above.
      await cache.addAll(BUILD.precache.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  // Only used by the dev/reviewer escape hatch in client/src/pwa.ts.
  if (event.data === "skip-waiting") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Not our business: other origins, and anything that is not a plain read.
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

/**
 * The app shell: network, then cache.
 *
 * Every navigation in this app is the same document — there is one screen and no
 * router — so an offline navigation to any path is answered with the cached
 * shell. That is also what makes the app work on a static host with no SPA
 * fallback.
 *
 * Offline, a navigation to some *other* path is answered with a redirect rather
 * than with the shell's bytes. The build uses a relative `base` so that it runs
 * unchanged at a domain root and under a subdirectory, and the price of that is
 * that the shell's asset URLs are only correct at the shell's own URL: handing
 * those bytes to `/app/deep/path` resolves them to `/app/deep/assets/…` and
 * paints nothing. Redirecting first costs one extra intercepted navigation and
 * lands the user on a working app.
 */
async function networkFirstShell(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    // A redirected response cannot be replayed for a navigation later, so it is
    // returned but not stored.
    if (response.ok && !response.redirected) await cache.put(SHELL, response.clone());
    return response;
  } catch (cause) {
    const cached = await cache.match(SHELL, MATCH);

    // Guarded on `cached` so a miss still reaches the offline notice below, and
    // on the URL so the redirect cannot target the request that caused it.
    if (cached && request.url !== SHELL) return Response.redirect(SHELL, 302);
    if (cached) return cached;

    // Nothing cached and no network: say so in the user's language rather than
    // letting the browser show its own error page.
    return new Response(
      "<!doctype html><html lang=ja><meta charset=utf-8><title>オフライン</title>" +
        "<p>オフラインです。この端末にアプリがまだ保存されていません。" +
        "一度オンラインで開いてから、もう一度お試しください。",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

/** Assets: cache, then network. Safe because every asset name is content-hashed. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  const cached = await cache.match(request, MATCH);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") await cache.put(request, response.clone());
  return response;
}
