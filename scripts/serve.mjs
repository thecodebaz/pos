// Servidor estático local para o build (`out/`) com COOP/COEP.
// OPFS exige crossOriginIsolated; alojamento em produção tem de enviar
// os mesmos cabeçalhos (ver README.md).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(dirname(fileURLToPath(import.meta.url))), "out");
const port = Number(process.env.PORT ?? 3000);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".db": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function resolveFile(urlPath) {
  let pathname = decodeURIComponent(urlPath.split("?")[0]);
  if (pathname.endsWith("/")) pathname += "index.html";
  const target = normalize(join(root, pathname));
  if (!target.startsWith(root + sep) && target !== root) return null;
  try {
    const info = await stat(target);
    if (info.isFile()) return target;
    if (info.isDirectory()) {
      const index = join(target, "index.html");
      if ((await stat(index)).isFile()) return index;
    }
  } catch {
    /* tenta fallback */
  }
  return null;
}

createServer(async (req, res) => {
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-cache",
  };

  let file = await resolveFile(req.url ?? "/");
  if (!file) {
    // Export estático com trailingSlash: tenta .html e, por fim, 404.
    const clean = (req.url ?? "/").split("?")[0].replace(/\/$/, "");
    file = await resolveFile(`${clean}/index.html`);
  }
  if (!file) {
    file = join(root, "404.html");
    res.writeHead(404, { ...headers, "Content-Type": types[".html"] });
    createReadStream(file).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...headers,
    "Content-Type": types[extname(file).toLowerCase()] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`POS disponível em http://localhost:${port}`);
});
