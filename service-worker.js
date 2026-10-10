// Service Worker do app "Integrador" (versão PC)
// Objetivo: permitir que o navegador ofereça "Instalar app" e evitar tela branca sem internet.
// Guarda só o "shell" (HTML, manifest e ícones). Os dados (produtos, estoque, vendas, financeiro)
// vêm sempre da API /api/odoo em tempo real, então o app precisa de internet para funcionar de verdade.

const CACHE_NAME = "deuris-pc-v2";
const SHELL = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Um por um, para que a falta de um arquivo não derrube a instalação inteira.
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Nunca mexe em POST, na API do Odoo nem em requisições de outros domínios.
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Rede primeiro (sempre a versão mais nova); se estiver offline, usa o cache.
  event.respondWith(
    fetch(req)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/index.html") : undefined))
      )
  );
});
