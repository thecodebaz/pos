// Empacota a app Electron a partir de uma pasta temporária sem node_modules.
// Isto evita que o electron-builder suba ao node_modules do projecto e inclua
// as dependências de build (Next, TypeScript, SWC, etc.) no app.asar.
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const sourcePkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const output = path.join(root, "dist-electron");
const workDir = path.join(os.tmpdir(), `pos-electron-build-${process.pid}`);

await rm(output, { recursive: true, force: true });
await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });

await cp(path.join(root, "electron"), path.join(workDir, "electron"), { recursive: true });
await cp(path.join(root, "out"), path.join(workDir, "out"), { recursive: true });
await cp(path.join(root, "build", "icon.ico"), path.join(workDir, "icon.ico"));

const buildConfig = structuredClone(sourcePkg.build);
buildConfig.electronVersion = sourcePkg.devDependencies.electron.replace(/^[~^]/, "");
buildConfig.npmRebuild = false;
buildConfig.directories = { output, buildResources: "." };
buildConfig.files = ["electron/**/*", "out/**/*", "icon.ico", "package.json"];
buildConfig.extraResources = [{ from: "icon.ico", to: "icon.ico" }];
buildConfig.win.icon = "icon.ico";

const pkg = {
  name: "pos-desktop",
  version: sourcePkg.version,
  private: true,
  main: "electron/main.cjs",
  productName: buildConfig.productName,
  description: "Ponto de venda offline com stock, clientes e relatórios.",
  author: "Codebaz",
  build: buildConfig,
};
await writeFile(path.join(workDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

const cli = path.join(root, "node_modules", "electron-builder", "cli.js");
const args = [cli, "--win", "--x64", ...process.argv.slice(2)];
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: workDir, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (exitCode) => resolve(exitCode ?? 1));
});

await rm(workDir, { recursive: true, force: true });
process.exit(code);
