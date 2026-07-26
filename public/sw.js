/* ============================================================
   YouForge Hub — Service Worker (SECTION 23d — added)
   App-shell caching only. This app is a live Firebase-backed
   marketplace (products, orders, chat, etc. all come from
   Firestore in real time), so this worker deliberately does NOT
   cache any Firestore/Firebase network traffic — only the static
   shell (this HTML file, the manifest, and the Google Fonts
   stylesheet/files) so the app can at least load its UI offline
   or on a flaky connection, then fetch live data once online.
   ============================================================ */

const CACHE_NAME = "youforge-shell-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch((err) => console.error("SW install: failed to pre-cache shell", err))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/** Never intercept anything other than same-origin GETs for the
 *  shell itself — Firebase/Firestore/Auth calls, CDN scripts
 *  (SheetJS, jsPDF, etc.), and any POST/PUT all pass straight
 *  through to the network untouched. */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isFonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!isSameOrigin && !isFonts) return; // let Firebase/CDN requests go straight to network

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200){
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // offline fallback to whatever's cached
      return cached || networkFetch;
    })
  );
});
