// Copia o runtime do sqlite-wasm para public/sqlite/.
// O worker carrega /sqlite/index.mjs com import() dinâmico para que
// import.meta.url resolva sqlite3.wasm e sqlite3-opfs-async-proxy.js
// a partir do mesmo diretório, em dev e em produção.

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "node_modules", "@sqlite.org", "sqlite-wasm", "dist");
const to = join(root, "public", "sqlite");

const files = ["index.mjs", "sqlite3.wasm", "sqlite3-opfs-async-proxy.js"];

await mkdir(to, { recursive: true });
for (const file of files) {
  await copyFile(join(from, file), join(to, file));
  console.log(`[sqlite] public/sqlite/${file}`);
}
