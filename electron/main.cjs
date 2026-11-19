const { app, BrowserWindow, Menu, dialog, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startStaticServer } = require("./static-server.cjs");

const APP_NAME = "POS Codebaz";
const APP_ID = "mz.codebaz.pos";
const PORT = Number(process.env.POS_ELECTRON_PORT ?? 37842);
const DEV_URL = process.env.ELECTRON_START_URL ?? "";

// A versão portátil guarda a base e os backups ao lado do .exe. A versão
// instalada usa %APPDATA%\POS Codebaz e não apaga nada ao desinstalar.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath("userData", path.join(process.env.PORTABLE_EXECUTABLE_DIR, "POS Codebaz - dados"));
}
app.setAppUserModelId(APP_ID);

let mainWindow = null;
let localServer = null;
let appUrl = DEV_URL;

function iconPath() {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "..", "build", "icon.ico");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function createWindow() {
  const icon = iconPath();
  const win = new BrowserWindow({
    title: APP_NAME,
    icon,
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    mainWindow = null;
  });

  const origin = new URL(appUrl).origin;
  win.webContents.on("will-navigate", (event, url) => {
    if (url === appUrl || url.startsWith(`${origin}/`)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(appUrl).catch((error) => {
    dialog.showErrorBox(APP_NAME, `Não foi possível abrir a aplicação:\n${error.message}`);
    app.quit();
  });
}

function setupDownloads() {
  const backupsDir = path.join(app.getPath("userData"), "Backups");
  fs.mkdirSync(backupsDir, { recursive: true });

  session.defaultSession.on("will-download", (event, item) => {
    const raw = path.basename(item.getFilename() || "backup.db");
    const filename = raw.replace(/[^a-zA-Z0-9._-]/g, "_") || "backup.db";
    const choice = dialog.showSaveDialogSync(mainWindow ?? BrowserWindow.getFocusedWindow(), {
      title: "Guardar backup",
      defaultPath: path.join(backupsDir, filename),
      filters: [
        { name: "Base SQLite", extensions: ["db", "sqlite", "sqlite3"] },
        { name: "Todos os ficheiros", extensions: ["*"] },
      ],
    });
    if (!choice) {
      item.cancel();
      return;
    }
    item.setSavePath(choice);
  });
}

function setupMenu() {
  const template = [
    {
      label: "Ficheiro",
      submenu: [{ label: "Sair", accelerator: "Alt+F4", role: "quit" }],
    },
    {
      label: "Ver",
      submenu: [
        { label: "Recarregar", accelerator: "Ctrl+R", role: "reload" },
        { label: "Recarregar forçado", accelerator: "Ctrl+Shift+R", role: "forceReload" },
        { type: "separator" },
        { label: "Ampliar", accelerator: "Ctrl+Plus", role: "zoomIn" },
        { label: "Reduzir", accelerator: "Ctrl+-", role: "zoomOut" },
        { label: "Tamanho normal", accelerator: "Ctrl+0", role: "resetZoom" },
        { type: "separator" },
        { label: "Ecrã inteiro", accelerator: "F11", role: "toggleFullscreen" },
        ...(!app.isPackaged || process.env.POS_DEVTOOLS === "1"
          ? [{ type: "separator" }, { label: "Ferramentas de programador", accelerator: "F12", role: "toggleDevTools" }]
          : []),
      ],
    },
    {
      label: "Ajuda",
      submenu: [
        {
          label: "Abrir pasta de dados",
          click: () => void shell.openPath(app.getPath("userData")),
        },
        {
          label: "Sobre",
          click: () => {
            dialog.showMessageBox(mainWindow ?? BrowserWindow.getFocusedWindow(), {
              type: "info",
              title: APP_NAME,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail:
                "Ponto de venda local. Os dados ficam neste dispositivo.\n" +
                `Pasta de dados: ${app.getPath("userData")}`,
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function bootstrap() {
  await app.whenReady();
  setupDownloads();
  setupMenu();

  if (!DEV_URL) {
    try {
      localServer = await startStaticServer({
        root: path.join(__dirname, "..", "out"),
        port: PORT,
      });
      appUrl = localServer.url;
    } catch (error) {
      dialog.showErrorBox(
        APP_NAME,
        `Não foi possível iniciar o servidor local na porta ${PORT}.\n\n${error.message}\n\n` +
          "Feche outra instância ou defina POS_ELECTRON_PORT com outra porta."
      );
      app.quit();
      return;
    }
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    if (localServer) void localServer.close();
  });
  bootstrap().catch((error) => {
    dialog.showErrorBox(APP_NAME, `Falha ao arrancar:\n${error.stack ?? error.message}`);
    app.quit();
  });
}
