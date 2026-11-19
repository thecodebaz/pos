// Servidor HTTP local usado pela versão Electron.
//
// Não serve por `file://` de propósito: a base SQLite WASM depende de OPFS e
// SharedArrayBuffer, que exigem contexto seguro e cross-origin isolated. Este
// servidor escuta apenas em 127.0.0.1 e envia os cabeçalhos COOP/COEP usados
// também pelo scripts/serve.mjs da PWA.

const { createReadStream } = require("node:fs");
const { stat } = require("node:fs/promises");
const { createServer } = require("node:http");
const { extname, isAbsolute, join, relative, resolve } = require("node:path");

const MIME = {
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

const HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-cache",
};

function contentType(file) {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function resolveFile(root, pathname) {
  let candidate = pathname;
  if (candidate.endsWith("/")) candidate += "index.html";

  const target = resolve(root, `.${candidate}`);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;

  try {
    const info = await stat(target);
    if (info.isFile()) return target;
    if (info.isDirectory()) {
      const index = join(target, "index.html");
      if ((await stat(index)).isFile()) return index;
    }
  } catch {
    /* tenta os fallbacks abaixo */
  }

  if (!extname(candidate)) {
    try {
      const index = resolve(root, `.${candidate}/index.html`);
      if ((await stat(index)).isFile()) return index;
    } catch {
      /* ignorado */
    }
    try {
      const html = resolve(root, `.${candidate}.html`);
      if ((await stat(html)).isFile()) return html;
    } catch {
      /* ignorado */
    }
  }
  return null;
}

function send(res, status, file, headers = {}) {
  res.writeHead(status, { ...HEADERS, ...headers, "Content-Type": contentType(file) });
  createReadStream(file).pipe(res);
}

function createAppServer(root) {
  return createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400, HEADERS).end("Pedido inválido");
      return;
    }

    const file = await resolveFile(root, pathname);
    if (file) {
      send(res, 200, file);
      return;
    }

    const notFound = join(root, "404.html");
    try {
      if ((await stat(notFound)).isFile()) {
        send(res, 404, notFound);
        return;
      }
    } catch {
      /* ignorado */
    }
    res.writeHead(404, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Não encontrado");
  });
}

/** Inicia o servidor e devolve o URL já com o porto escolhido. */
function startStaticServer({ root, port }) {
  const server = createAppServer(resolve(root));
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolvePromise({
        server,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startStaticServer };
