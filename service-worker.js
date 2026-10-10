// Service worker do Integrador Odoo PC
// - Nunca guarda chamadas da API (/api/...): os dados do Odoo sempre vêm da rede.
// - Páginas: rede primeiro (o site é atualizado com frequência); sem internet, abre a última cópia guardada.
// - Ícones e manifest: guardados para abrir mais rápido.
const VERSAO = 'deuris-pc-v1';
const ARQUIVOS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'];
const ESTATICOS = new Set(['/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']);

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(VERSAO)
            .then((cache) => Promise.all(ARQUIVOS.map((url) => cache.add(url).catch(() => {}))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;

    // Abrir o app / recarregar a página: rede primeiro, cópia guardada se estiver sem internet
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((resp) => {
                    if (resp && resp.ok) {
                        const copia = resp.clone();
                        caches.open(VERSAO).then((c) => c.put('/', copia)).catch(() => {});
                    }
                    return resp;
                })
                .catch(() => caches.match('/').then((r) => r || caches.match('/index.html')))
        );
        return;
    }

    // Ícones e manifest: usa o guardado e atualiza em segundo plano
    if (ESTATICOS.has(url.pathname)) {
        event.respondWith(
            caches.match(req).then((guardado) => {
                const rede = fetch(req).then((resp) => {
                    if (resp && resp.ok) {
                        const copia = resp.clone();
                        caches.open(VERSAO).then((c) => c.put(req, copia)).catch(() => {});
                    }
                    return resp;
                }).catch(() => guardado);
                return guardado || rede;
            })
        );
    }
});
