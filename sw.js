const CACHE='workout-v2';

self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  e.respondWith(fetch(e.request).then(r=>{
    if(r.ok&&e.request.method==='GET'){const c=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,c))}
    return r}).catch(()=>caches.match(e.request)))
});
