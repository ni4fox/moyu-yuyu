const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("moyu", {
  hide: () => ipcRenderer.send("win:hide"),
  setTop: (on) => ipcRenderer.send("win:top", on),
  setHover: (on) => ipcRenderer.send("win:hover", on),
  setAdaptive: (on) => ipcRenderer.send("win:adaptive", on),
  setOpacity: (v) => ipcRenderer.send("win:opacity", v),
  getPort: () => ipcRenderer.sendSync("win:port"),
  getToken: () => ipcRenderer.sendSync("win:token"),
  openExternal: (url) => ipcRenderer.send("win:external", url),
  getPrefs: () => ipcRenderer.invoke("prefs:get"),
  onOpen: (cb) => ipcRenderer.on("moyu:open", (_e, url) => cb(url)),
  onPrefs: (cb) => ipcRenderer.on("prefs:changed", (_e, p) => cb(p)),
  pickDoc: () => ipcRenderer.invoke("doc:pick"),
  pickFolder: () => ipcRenderer.invoke("doc:pick-folder"),
  readDoc: (p) => ipcRenderer.invoke("doc:read", p),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ""; } }
});
