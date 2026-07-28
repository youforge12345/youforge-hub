/* ============================================================
   YouForge Hub — Service Worker (SECTION 23d — updated)
   App-shell caching only. This app is a live Firebase-backed
   marketplace (products, orders, chat, etc. all come from
   Firestore in real time), so this worker deliberately does NOT
   cache any Firestore/Firebase network traffic — only the static
   shell (this HTML file, the manifest, and the Google Fonts
   stylesheet/files) so the app can at least load its UI offline
   or on a flaky connection, then fetch live data once online.

   FIX (this version): the shell document (index.html / "/") now
   uses NETWORK-FIRST instead of cache-first. Previously, a deploy
   could feel "one version behind" because the old cached HTML was
   served instantly while the new one only updated in the
   background for NEXT time. Now: online -> always get the latest
   deployed HTML; offline -> fall back to whatever was last cached.
   Bump CACHE_NAME (below) on any future change to this file itself
   so old caches get cleaned up automatically.
   ============================================================ */

/* ---- Web Push (SECTION 23i — added) ----
   Handles a push arriving while no tab is open/focused (foreground
   messages are instead shown as an in-app toast — see YF.push in
   index.html). Loaded via importScripts (compat build) since service
   workers can't use ES module imports without a bundler. Never
   blocks the app-shell caching logic above if this fails to load
   (e.g. offline on first install) — wrapped in try/catch. */
try{
  importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");
  firebase.initializeApp({
    apiKey:            "AIzaSyB8Pihb7WEKoHedbLHO4emiuqE1miO_smk",
    authDomain:        "webhub-b92cc.firebaseapp.com",
    projectId:         "webhub-b92cc",
    storageBucket:     "webhub-b92cc.firebasestorage.app",
    messagingSenderId: "213170844721",
    appId:             "1:213170844721:web:932a921cbfe1c2d34d1110"
  });
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || "YouForge Hub";
    const options = {
      body: (payload.notification && payload.notification.body) || "",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23000000'/%3E%3Ctext x='32' y='42' text-anchor='middle' font-family='Georgia,serif' font-weight='700' font-size='28' fill='%23d4af37'%3EYF%3C/text%3E%3C/svg%3E"
    };
    self.registration.showNotification(title, options);
  });
}catch(err){ console.error("SW: Firebase Messaging setup failed (app still works without push):", err); }

const CACHE_NAME = "youforge-shell-v2";
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

  // The HTML shell itself (navigations, and index.html/"/" directly):
  // NETWORK-FIRST so a fresh deploy is visible immediately while
  // online. Falls back to the last cached copy only if the network
  // request fails (offline / flaky connection).
  const isHtmlShell = req.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname === "/";
  if (isHtmlShell){
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200){
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else in the shell (manifest.json, fonts): cache-first
  // with a background refresh — fine for assets that rarely change.
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
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
