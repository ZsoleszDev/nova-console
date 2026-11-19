const { contextBridge, ipcRenderer } = require("electron");
const call = (name, ...args) => ipcRenderer.invoke("nova-picker:" + name, ...args);
contextBridge.exposeInMainWorld("novaPicker", {
  getState: () => call("state"),
  choose: (mode) => call("choose", mode),
  retry: () => call("retry"),
  cancelCountdown: () => call("cancel-countdown"),
  close: () => call("close"),
  save: (patch) => call("save", patch),
  browseJarvis: () => call("browse-jarvis"),
  startupTakeover: () => call("startup-takeover"),
  startupRestore: () => call("startup-restore"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("nova-picker:update", listener);
    return () => ipcRenderer.removeListener("nova-picker:update", listener);
  },
});
