// O shell abre offline depois do primeiro acesso HTTPS/localhost.
// API e tiles nunca são cacheados aqui: dados persistidos e fila ficam no IndexedDB.
const CACHE='alagora-shell-v4';
const FIXOS=['/icon.svg','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/manifest.webmanifest'];
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    const response=await fetch('/',{cache:'reload'});
    if(!response.ok)throw new Error('Não foi possível preparar o shell offline.');
    const html=await response.clone().text();
    await cache.put('/',response);
    const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match=>match[1]);
    await cache.addAll([...FIXOS,...assets]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(e.request.mode==='navigate')e.respondWith(fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put('/',copy));}return r;}).catch(()=>caches.match('/')));
  // Os assets são públicos e identificados por hash; ignorar Vary evita que o
  // cabeçalho Origin do carregamento de módulos invalide o precache do shell.
  else if(url.pathname.startsWith('/assets/')||FIXOS.includes(url.pathname))e.respondWith(caches.match(e.request,{ignoreVary:true}).then(cached=>cached||fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}return r;})));
});
