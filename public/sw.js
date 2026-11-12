// public/sw.js — pass-through, deliberately no cache (design §11.3.2, FR-104)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* no respondWith: network as usual */ });
