const { contextBridge, ipcRenderer } = require("electron");
const names = [
  "getState",
  "getMediaLibrary",
  "addMediaFolder",
  "scanMediaLibrary",
  "removeMediaFolder",
  "setMediaWatched",
  "prepareLibraryMedia",
  "prepareNextLibraryMedia",
  "listContinueMedia",
  "prepareContinueMedia",
  "getLocalSubtitle",
  "saveLocalPlayback",
  "releaseLocalMedia",
  "saveSettings",
  "addFile",
  "listWindowsApps",
  "addWindowsApp",
  "importSteam",
  "launchGame",
  "removeGame",
  "toggleFavorite",
  "renameGame",
  "setArtwork",
  "setTileImage",
  "openStore",
  "openExternal",
  "systemSettings",
  "setFullscreen",
  "minimize",
  "close",
  "power",
  "getSystem",
  "openMedia",
  "getMediaState",
  "mediaCommand",
  "sendMediaText",
  "showMediaControls",
  "relayMediaPad",
  "getConsoleState",
  "showConsole",
  "resumeGame",
  "enterDesktop",
  "openGameGuide",
  "getGuideState",
  "guideCommand",
  "getPlaytime",
];
contextBridge.exposeInMainWorld("nova", {
  ...Object.fromEntries(
    names.map((name) => [
      name,
      (...args) => ipcRenderer.invoke("nova:" + name, ...args),
    ]),
  ),
  onRecovered: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("nova:recovered", listener);
    return () => ipcRenderer.removeListener("nova:recovered", listener);
  },
  onWindowActive: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("nova:window-active", listener);
    return () => ipcRenderer.removeListener("nova:window-active", listener);
  },
  onControllerInput: (callback) => {
    const listener = (_event, input) => callback(input);
    ipcRenderer.on("nova:controller-input", listener);
    return () => ipcRenderer.removeListener("nova:controller-input", listener);
  },
  onControllerState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("nova:controller-state", listener);
    return () => ipcRenderer.removeListener("nova:controller-state", listener);
  },
  onGuideChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("nova:guide", listener);
    return () => ipcRenderer.removeListener("nova:guide", listener);
  },
  onPlaytime: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("nova:playtime", listener);
    return () => ipcRenderer.removeListener("nova:playtime", listener);
  },
  onNavigate: (callback) => {
    const listener = (_event, page) => callback(page);
    ipcRenderer.on("nova:navigate", listener);
    return () => ipcRenderer.removeListener("nova:navigate", listener);
  },
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("nova:state", listener);
    return () => ipcRenderer.removeListener("nova:state", listener);
  },
  onMediaChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("nova:media", listener);
    return () => ipcRenderer.removeListener("nova:media", listener);
  },
  onMediaInput: (callback) => {
    const listener = (_event, input) => callback(input);
    ipcRenderer.on("nova:media-input", listener);
    return () => ipcRenderer.removeListener("nova:media-input", listener);
  },
  onMediaNotice: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("nova:media-notice", listener);
    return () => ipcRenderer.removeListener("nova:media-notice", listener);
  },
  onConsoleChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("nova:console", listener);
    return () => ipcRenderer.removeListener("nova:console", listener);
  },
  onShowConsole: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("nova:show-console", listener);
    return () => ipcRenderer.removeListener("nova:show-console", listener);
  },
});
