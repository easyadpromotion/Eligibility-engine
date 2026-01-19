// Simple Service Worker to make the app installable
self.addEventListener('fetch', function(event) {
  // This is a dummy listener to satisfy PWA requirements
  event.respondWith(fetch(event.request));
});