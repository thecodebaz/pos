// Arranca o Next dev e abre a mesma app dentro do Electron.
// Uso: npm run electron:dev
const { spawn } = require("node:child_process");
const http = require("node:http");
const electronPath = require("electron");

const DEV_URL = process.env.ELECTRON_START_URL ?? "http://localhost:3000";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

let electronChild = null;
let nextChild = null;
let exiting = false;

function stop(child) {
  if (!child || child.pid == null || child.exitCode != null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  stop(electronChild);
  stop(nextChild);
  process.exit(code);
}

function waitForServer(url, attempts = 150) {
  return new Promise((resolve, reject) => {
    const check = (left) => {
      const request = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry(left);
      });
      request.setTimeout(2000, () => request.destroy());
      request.on("error", () => retry(left));
    };
    const retry = (left) => {
      if (left <= 0) {
        reject(new Error(`O servidor não respondeu em ${url}`));
        return;
      }
      setTimeout(() => check(left - 1), 1000);
    };
    check(attempts);
  });
}

nextChild = spawn(npm, ["run", "dev"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
nextChild.on("exit", (code) => {
  if (!exiting) shutdown(code ?? 1);
});

waitForServer(DEV_URL)
  .then(() => {
    if (exiting) return;
    electronChild = spawn(electronPath, ["."], {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_START_URL: DEV_URL },
    });
    electronChild.on("exit", (code) => shutdown(code ?? 0));
  })
  .catch((error) => {
    console.error(error.message);
    shutdown(1);
  });

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
