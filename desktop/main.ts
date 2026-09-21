import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { type DesktopConfig, ensureServer } from "./runtime.js";

const configuration = JSON.parse(
  readFileSync(join(app.getAppPath(), "desktop-config.json"), "utf8"),
) as DesktopConfig;
let captureWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const captureURL = `${configuration.serverURL}/#capture`;

async function showCapture() {
  try {
    await ensureServer(configuration);
    if (quitting) return;
    if (!captureWindow) {
      captureWindow = new BrowserWindow({
        width: 640,
        height: 280,
        show: false,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        backgroundColor: "#141b24",
        roundedCorners: true,
        title: "Panopticon — Quick capture",
        webPreferences: {
          preload: join(app.getAppPath(), "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      captureWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      captureWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      captureWindow.webContents.on("will-navigate", (event, url) => {
        if (url !== captureURL) event.preventDefault();
      });
      captureWindow.on("close", (event) => {
        event.preventDefault();
        captureWindow?.hide();
      });
      captureWindow.on("blur", () => captureWindow?.hide());
      await captureWindow.loadURL(captureURL);
    }
    const { x, y, width, height } = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workArea;
    captureWindow.setPosition(Math.round(x + (width - 640) / 2), Math.round(y + height * 0.23));
    captureWindow.show();
    captureWindow.focus();
  } catch (error) {
    dialog.showErrorBox(
      "Could not open My Mind",
      error instanceof Error ? error.message : "Please restart the assistant.",
    );
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    void showCapture();
  });
  void app.whenReady().then(async () => {
    app.setName("My Mind");
    app.dock?.hide();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: "My Mind", submenu: [{ role: "quit" }] },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
      ]),
    );
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle("🧠");
    tray.setToolTip("My Mind — quick capture");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Capture a thought",
          accelerator: configuration.shortcut,
          click: () => {
            void showCapture();
          },
        },
        {
          label: "Open personal assistant",
          click: () => {
            void ensureServer(configuration)
              .then(() => shell.openExternal(configuration.serverURL))
              .catch((error: Error) =>
                dialog.showErrorBox("Could not open assistant", error.message),
              );
          },
        },
        { type: "separator" },
        { label: "Quit My Mind", click: () => app.quit() },
      ]),
    );
    if (
      !globalShortcut.register(configuration.shortcut, () => {
        if (captureWindow?.isVisible()) captureWindow.hide();
        else void showCapture();
      })
    )
      dialog.showErrorBox(
        "Shortcut unavailable",
        `${configuration.shortcut} is already in use. Capture is available through the Mind menu. Set PA_CAPTURE_SHORTCUT and reinstall to change it.`,
      );
    ipcMain.on("capture:hide", (event) => {
      if (event.sender === captureWindow?.webContents && event.senderFrame?.url === captureURL)
        captureWindow.hide();
    });
    app.on("activate", () => {
      void showCapture();
    });
    app.on("window-all-closed", () => {});
    app.on("before-quit", () => {
      quitting = true;
      captureWindow?.removeAllListeners("close");
    });
    app.on("will-quit", () => {
      globalShortcut.unregisterAll();
      tray?.destroy();
    });
    if (!process.argv.includes("--background")) await showCapture();
  });
}
