var CACHE_NAME = "clagentic-console-offline-v__VERSION__";

// Colours of the offline placeholder page. The server fills this in when it
// serves the worker (lib/theme-seed.js), from the bundled theme files, so the
// worker holds no colour of its own.
var OFFLINE_PAGE_CSS = "__OFFLINE_PAGE_CSS__";

// Minimal app-shell paths pre-cached on install so the new cache generation
// is never empty at activate time. Without this, an offline mobile client
// that goes offline in the window between activate (old cache deleted) and
// the first successful network fetch (cache repopulated) falls through to
// the bare "Waiting for server..." placeholder instead of the real shell
// (lr-e0ec47).
var SHELL_URLS = ["/", "/index.html"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_URLS).catch(function () {
        // Best-effort: a shell fetch failing (e.g. offline install) must not
        // block skipWaiting — the fetch handler's cache-fallback still works
        // for whatever the previous cache generation already holds.
      });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  // Clean up old cache versions only after the new cache has the app shell
  // (guaranteed by install above), so there is no window where a client can
  // hit an empty cache and fall through to the minimal offline placeholder.
  // Every cache not named CACHE_NAME goes, which includes the caches of the
  // earlier "clagentic-offline-v*" naming.
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); })
      );
    }).then(function () {
      return self.clients.claim();
    }).then(function () {
      // Notify all open clients that a new version is active so they can reload
      return self.clients.matchAll({ type: "window" }).then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          clientList[i].postMessage({ type: "sw-updated" });
        }
      });
    })
  );
});

// --- Offline cache: network-first, cache-fallback ---

function shouldCache(request, response) {
  if (request.method !== "GET") return false;
  if (!response || !response.ok) return false;
  // Cache same-origin static assets and CDN resources (jsdelivr, fonts)
  var url = new URL(request.url);
  if (url.origin === self.location.origin) return true;
  if (url.hostname === "cdn.jsdelivr.net") return true;
  if (url.hostname === "fonts.googleapis.com") return true;
  if (url.hostname === "fonts.gstatic.com") return true;
  return false;
}

self.addEventListener("fetch", function (event) {
  var request = event.request;

  // Only handle GET requests
  if (request.method !== "GET") return;

  // Skip cross-origin requests (external images, fonts, etc.)
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Skip WebSocket upgrade requests and API/data endpoints
  if (url.pathname.indexOf("/ws") !== -1) return;
  if (url.pathname.indexOf("/api/") !== -1) return;

  event.respondWith(
    fetch(request).then(function (response) {
      // Network succeeded: cache a clone for offline use
      if (shouldCache(request, response)) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(request, clone);
        });
      }
      return response;
    }).catch(function () {
      // Network failed: serve from cache
      return caches.match(request).then(function (cached) {
        if (cached) return cached;

        // For navigation requests, serve cached index.html as fallback
        // (handles /p/slug/ routes that all serve the same SPA shell)
        if (request.mode === "navigate") {
          return caches.match("/index.html").then(function (indexCached) {
            // If even the index page is not cached, show a minimal offline page
            if (indexCached) return indexCached;
            return new Response(
              "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Clagentic: Console</title>" +
              "<style>body{margin:0;display:flex;" +
              "align-items:center;justify-content:center;height:100vh;" +
              "font-family:monospace;font-size:1.2em}" +
              OFFLINE_PAGE_CSS +
              "</style></head>" +
              "<body><p>Waiting for server&hellip;</p></body></html>",
              { headers: { "Content-Type": "text/html" } }
            );
          });
        }
        // Non-navigation request with no cache: return network error
        return new Response("", { status: 503, statusText: "Offline" });
      });
    })
  );
});

// --- Push notifications ---

// The show, close and tap logic lives in notify-sw-logic.js so it can be tested
// without a browser; this file only wires it to the worker's events.
importScripts("/notify-target.js", "/notify-sw-logic.js");

function notifyEnv() {
  return {
    registration: self.registration,
    clients: self.clients,
    userAgent: self.navigator ? self.navigator.userAgent : "",
    scope: self.registration.scope || "/",
  };
}

self.addEventListener("push", function (event) {
  // An unreadable payload is handled as an empty one: the push still shows the
  // silent notice instead of leaving the browser to post its generic one.
  var data = null;
  try { data = event.data.json(); } catch (e) { data = null; }
  event.waitUntil(NotifySw.handlePush(notifyEnv(), data).catch(function () {
    return NotifySw.handlePush(notifyEnv(), null).catch(function () {});
  }));
});

// --- Notification click ---

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(NotifySw.handleClick(notifyEnv(), event.notification));
});
