import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("quickCapture", {
  hide: () => ipcRenderer.send("capture:hide"),
});
