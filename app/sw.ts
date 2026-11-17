import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig, SerwistPlugin } from "serwist";
import { ExpirationPlugin, NetworkFirst, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
  interface Window extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

// O service worker corre num WorkerGlobalScope, mas o tsconfig da app inclui a lib DOM.
const sw = self as unknown as WorkerGlobalScope & {
  skipWaiting(): Promise<void>;
};

// Uma resposta de erro HTTP (proxy, portal cativo, 5xx) não é uma página válida.
// Sem isto a estratégia "rede primeiro" devolveria o erro em vez do POS em cache.
const rejectHttpErrors: SerwistPlugin = {
  async fetchDidSucceed({ response }) {
    if (!response.ok) throw new Error(`Resposta HTTP ${response.status} para ${response.url}`);
    return response;
  },
};

// Navegações: rede primeiro, mas sempre com recurso à última página guardada.
// Isto cobre o arranque offline, proxies com erro e servidores em baixo.
const navigationCaching = {
  matcher: ({ request, sameOrigin }: { request: Request; sameOrigin: boolean }) =>
    sameOrigin && request.mode === "navigate",
  handler: new NetworkFirst({
    cacheName: "pages",
    networkTimeoutSeconds: 4,
    plugins: [
      rejectHttpErrors,
      new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
};

// O worker SQLite muda em cada build e não faz parte do manifesto precached.
// NetworkFirst evita que uma cópia antiga em cache continue a correr após uma
// actualização; em offline usa a última versão guardada.
const sqliteWorkerCaching = {
  matcher: ({ request, sameOrigin }: { request: Request; sameOrigin: boolean }) =>
    sameOrigin && new URL(request.url).pathname === "/workers/sqlite.worker.js",
  handler: new NetworkFirst({
    cacheName: "sqlite-worker",
    plugins: [rejectHttpErrors, new ExpirationPlugin({ maxEntries: 4 })],
  }),
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: false,
  clientsClaim: true,
  // Com navigation preload a resposta de rede é devolvida diretamente e ignora
  // os plugins da estratégia, pelo que uma resposta 5xx impediria o fallback.
  navigationPreload: false,
  runtimeCaching: [navigationCaching, sqliteWorkerCaching, ...defaultCache],
  fallbacks: {
    entries: [
      {
        // Página estática e autónoma (sem chunks com hash), por isso pode ser
        // precached e continua válida depois de cada actualização.
        url: "/offline.html",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

(sw as unknown as EventTarget).addEventListener("message", (event) => {
  const data = (event as MessageEvent).data as unknown;
  if (data === "SKIP_WAITING" || (typeof data === "object" && data !== null && (data as { type?: string }).type === "SKIP_WAITING")) {
    void sw.skipWaiting();
  }
});

serwist.addEventListeners();
