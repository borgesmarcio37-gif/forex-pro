const { app, BrowserWindow, shell, Menu, Tray, nativeImage } = require("electron");
const path = require("path");
const { fork } = require("child_process");

let win, tray, serverProcess;

// ── Start Express server as child process ─────────────────────────────────────
function startServer() {
  serverProcess = fork(path.join(__dirname, "server/index.js"), [], {
    env: { ...process.env },
    silent: false,
  });
  serverProcess.on("error", err => console.error("[electron] Server error:", err));
  serverProcess.on("exit", code => console.log("[electron] Server exited:", code));
}

// ── Wait for server to be ready ───────────────────────────────────────────────
function waitForServer(url, maxAttempts = 20) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const http = require("http");
      http.get(`${url}/health`, res => {
        if (res.statusCode === 200) resolve();
        else retry();
      }).on("error", retry);
    };
    const retry = () => {
      attempts++;
      if (attempts >= maxAttempts) reject(new Error("Server did not start"));
      else setTimeout(check, 500);
    };
    check();
  });
}

// ── Create main window ────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "Forex Master Pro v7",
    icon: path.join(__dirname, "client/public/favicon.ico"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: "#03060e",
    show: false,
    titleBarStyle: "default",
    autoHideMenuBar: true, // clean look — press Alt to show menu
  });

  // Load built React app
  const buildPath = path.join(__dirname, "client/build/index.html");
  win.loadFile(buildPath);

  // Show when ready
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  // Open external links in browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => { win = null; });
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, "client/public/favicon.ico");
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Forex Master Pro v7");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir", click: () => { if(win) win.show(); else createWindow(); } },
    { type: "separator" },
    { label: "Sair", click: () => app.quit() },
  ]));
  tray.on("double-click", () => { if(win) win.show(); });
}

// ── App menu ──────────────────────────────────────────────────────────────────
function createMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "Forex Master Pro",
      submenu: [
        { label: "Sobre", role: "about" },
        { type: "separator" },
        { label: "Sair", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { label: "Recarregar", accelerator: "CmdOrCtrl+R", click: () => win?.reload() },
        { label: "Zoom +", accelerator: "CmdOrCtrl+=", role: "zoomIn" },
        { label: "Zoom -", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
        { label: "Tamanho original", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
        { type: "separator" },
        { label: "Ecrã inteiro", accelerator: "F11", role: "togglefullscreen" },
      ],
    },
    {
      label: "Ferramentas",
      submenu: [
        { label: "DevTools", accelerator: "F12", click: () => win?.webContents.toggleDevTools() },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createMenu();

  // Start server and wait
  startServer();
  try {
    await waitForServer("http://localhost:3001/api");
    console.log("[electron] Server ready");
  } catch(e) {
    console.error("[electron] Server timeout — loading anyway");
  }

  createWindow();
  createTray();
});

app.on("window-all-closed", () => {
  // Keep running in tray on Windows/Linux
  if (process.platform === "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
