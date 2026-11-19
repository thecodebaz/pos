// Gera build/icon.ico a partir do ícone PWA já existente.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pngToIco from "png-to-ico";

const root = process.cwd();
const source = path.join(root, "public", "icons", "icon-512.png");
const target = path.join(root, "build", "icon.ico");

await mkdir(path.dirname(target), { recursive: true });
const ico = await pngToIco(source);
await writeFile(target, ico);
console.log(`Ícone Electron criado: ${path.relative(root, target)}`);
