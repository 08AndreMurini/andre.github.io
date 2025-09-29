const CACHE_NAME = 'face-capture-v2'; // Alterado o nome para forçar a atualização do cache
const STATIC_CACHE = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/manifest.json',
    // Adicione os ícones PWA para garantir que a interface de instalação offline funcione corretamente
    '/icons/icon-512x512.png', // Exemplo do ícone principal do manifest
    // Certifique-se de listar todos os ícones usados no manifest.json
];

const OFFLINE_URL = '/index.html'; // Usar a página principal como fallback offline

// --- 1. Evento 'install': Cache de Arquivos Estáticos ---
self.addEventListener('install', (event) => {
    // Forçar o Service Worker a esperar a instalação e cache ser concluído
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Service Worker: Arquivos estáticos em cache.');
                return cache.addAll(STATIC_CACHE);
            })
            // Força a ativação imediatamente, pulando o estado 'waiting'
            .then(() => self.skipWaiting()) 
    );
});

// --- 2. Evento 'activate': Limpeza de Caches Antigos ---
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            // Usa .filter e .map para retornar promessas de exclusão de caches antigos
            return Promise.all(
                cacheNames
                    .filter(cacheName => cacheName !== CACHE_NAME)
                    .map(cacheName => {
                        console.log(`Service Worker: Deletando cache antigo: ${cacheName}`);
                        return caches.delete(cacheName);
                    })
            );
        }).then(() => self.clients.claim()) // Permite que o SW controle imediatamente as páginas abertas
    );
});

// --- 3. Evento 'fetch': Estratégia de Cache-First com Fallback de Rede e Cache Dinâmico ---
self.addEventListener('fetch', (event) => {
    const requestUrl = new URL(event.request.url);

    // Ignorar requisições que não sejam GET ou que sejam de terceiros (CORS/API)
    // O código já ignora o '/upload' e métodos que não sejam GET, mantendo a lógica de API
    if (event.request.method !== 'GET' || 
        event.request.url.includes('/upload') ||
        requestUrl.origin !== location.origin
    ) {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                // Se houver resposta em cache, retorne-a imediatamente (Cache-First)
                if (cachedResponse) {
                    return cachedResponse;
                }

                // Se não houver cache, faça a requisição de rede
                return fetch(event.request)
                    .then((networkResponse) => {
                        // Verifica se a resposta é válida e armazena em cache (Cache Dinâmico)
                        if (networkResponse.status === 200) {
                            const responseClone = networkResponse.clone();
                            caches.open(CACHE_NAME)
                                .then(cache => {
                                    cache.put(event.request, responseClone);
                                });
                        }
                        return networkResponse;
                    })
                    .catch(() => {
                        // Fallback offline: Tenta retornar a URL principal (index.html)
                        console.log('Service Worker: Falha na requisição de rede. Tentando fallback offline.');
                        return caches.match(OFFLINE_URL);
                    });
            })
    );
});