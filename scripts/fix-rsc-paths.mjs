// Next.js 16 no Windows gera payloads RSC em pastas aninhadas
// (ex.: out/produtos/__next.!KGFwcCk/produtos/__PAGE__.txt), mas o router
// pede o caminho achatado (__next.!KGFwcCk.produtos.__PAGE__.txt).
// Ver https://github.com/vercel/next.js/issues/85374.
// Este passo pós-build achata esses ficheiros e remove as pastas vazias.

import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const outDir = join(process.cwd(), "out");
let moved = 0;

async function flatten(dir, parent, prefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await flatten(full, parent, `${prefix}.${entry.name}`);
      continue;
    }
    const target = join(parent, `${prefix}.${entry.name}`);
    const exists = await stat(target).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await rename(full, target);
      moved += 1;
    }
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith("__next.")) {
      await flatten(full, dir, entry.name);
      await rm(full, { recursive: true, force: true });
    } else {
      await walk(full);
    }
  }
}

await walk(outDir);
if (moved > 0) console.log(`[rsc] ${moved} payload(s) RSC achatado(s) para o router do Next 16.`);
