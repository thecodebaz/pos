import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// O sqlite-wasm instancia o proxy OPFS com ?vfs=... e a versão do worker lê esse
// parâmetro de location.search. Se o service worker devolver a cópia precached
// sem query, o proxy falha offline. Por isso as duas variantes são precached
// com o URL completo.
function proxyRevision(): string | null {
  try {
    const file = readFileSync(join(process.cwd(), "public/sqlite/sqlite3-opfs-async-proxy.js"));
    return createHash("sha256").update(file).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

const opfsProxyEntries = ["opfs", "opfs-wl"].map((vfs) => ({
  url: `/sqlite/sqlite3-opfs-async-proxy.js?vfs=${vfs}`,
  revision: proxyRevision(),
}));

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // O service worker só é gerado no build de produção.
  disable: process.env.NODE_ENV !== "production",
  cacheOnNavigation: true,
  reloadOnOnline: true,
  // No Windows, os ficheiros de public/ entram no manifesto com "\"; os URLs
  // são normalizados pelo browser e pela Cache API. As variantes do proxy OPFS
  // são acrescentadas aqui porque additionalPrecacheEntries substituiria os
  // ficheiros de public/ em vez de os acrescentar.
  manifestTransforms: [
    (entries) => ({
      manifest: [
        ...entries.map((entry) => ({ ...entry, url: entry.url.replace(/\\/g, "/") })),
        ...opfsProxyEntries.map((entry) => ({ ...entry, size: 0 })),
      ],
      warnings: [],
    }),
  ],
});

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // O export estático não suporta headers(); em produção, vercel.json define-os.
  ...(process.env.NODE_ENV === "development"
    ? {
        async headers() {
          return [
            {
              source: "/:path*",
              headers: [
                { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
                { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
                { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
              ],
            },
          ];
        },
      }
    : {}),
};

export default withSerwist(nextConfig);
