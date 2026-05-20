const CACHE='workout-v131';

const PRECACHE=[
  './v3.html',
  './manifest-v3.json',
  './icon-192.png',
  './icon-512.png',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap'
];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting()))
});

self.addEventListener('activate',e=>e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())
));

self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET')return;
  if(u.pathname.endsWith('.html')||u.pathname==='/'||u.pathname.endsWith('/workout/')||u.pathname==='/workout'){
    e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{
      const c=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,c));return r
    }).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request).then(r=>{
      if(r.ok){const c=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,c))}
      return r
    }).catch(()=>caches.match(e.request))
  );
});
