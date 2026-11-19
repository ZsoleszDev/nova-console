const {
  app,
  protocol,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  powerMonitor,
  nativeImage,
  screen,
  Notification,
  globalShortcut,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const { createMediaIntegration } = require("./media.cjs");
const { createConsoleMode } = require("./console-mode.cjs");
const { createLocalFiles } = require("./local-files.cjs");
const { createMediaLibrary } = require("./media-library.cjs");
const { createIdleClock } = require("./idle-clock.cjs");
const { createBatteryNotice } = require("./idle-policy.cjs");
const { createArtwork } = require("./artwork.cjs");
const { createModeManager } = require("./mode-manager.cjs");
const { createServices } = require("./services.cjs");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "nova-art",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "nova-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
const { createGameGuide } = require("./game-guide.cjs");
const { createPlaytimeTracker } = require("./playtime.cjs");
const consolePolicy = require("./console-policy.cjs");
const {
  defaults,
  modes: modeIds,
  modeCountdowns,
  validateGame,
  parseSteamLibraryPaths,
  parseSteamManifest,
  loadState,
  saveState,
} = require("./core.cjs");
let win,
  state,
  file,
  media,
  consoleMode,
  guide,
  playtime,
  localFiles,
  artwork,
  mediaLibrary,
  idleClock,
  recoveryTimer,
  modes,
  batteryPending = false,
  updateSettings;
const isWindows = process.platform === "win32";
const pending = new Set();
// A NOVA start this soon after sign-in counts as a sign-in start, however it was launched.
const SIGN_IN_WINDOW_MS = 4 * 60 * 1000;
function startupLog(text) {
  try {
    const file = path.join(app.getPath("userData"), "modvalaszto-naplo.txt");
    try {
      if (fs.statSync(file).size > 65536)
        fs.renameSync(file, file.replace(/\.txt$/, ".regi.txt"));
    } catch {}
    fs.appendFileSync(
      file,
      `${new Date().toLocaleString("hu-HU")}  NOVA ${app.getVersion()}  ${text}\r\n`,
      "utf8",
    );
  } catch {}
}
const persist = () => {
  saveState(file, state);
  if (win && !win.isDestroyed()) win.webContents.send("nova:state", state);
  return state;
};
const requireWindows = () => {
  if (!isWindows)
    throw Error("Ez a funkció a Windowsos NOVA alkalmazásban érhető el.");
};
const powershell = async (script) => {
  requireWindows();
  return (
    await run(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    )
  ).stdout
    .replace(/^\uFEFF/, "")
    .trim();
};
const add = (game) => {
  const existing = state.games.find(
    (g) => g.type === game.type && g.target === game.target,
  );
  if (existing) return existing;
  const checked = validateGame(game);
  state.games.push(checked);
  persist();
  return checked;
};
function handle(name, fn) {
  ipcMain.handle("nova:" + name, async (event, ...args) => {
    if (event.sender !== win.webContents) throw Error("Tiltott hívás.");
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || "A művelet nem sikerült." };
    }
  });
}
function setup() {
  handle("getMediaLibrary", () => mediaLibrary.snapshot());
  handle("addMediaFolder", (kind, name, folderPath) =>
    mediaLibrary.addRoot(kind, name, folderPath),
  );
  handle("scanMediaLibrary", () => mediaLibrary.scan());
  handle("removeMediaFolder", (id) => mediaLibrary.removeRoot(id));
  handle("setMediaWatched", (id, watched) =>
    mediaLibrary.setWatched(id, watched),
  );
  handle("prepareLibraryMedia", (id) => mediaLibrary.prepare(id));
  handle("prepareNextLibraryMedia", (id) => mediaLibrary.next(id));
  handle("listContinueMedia", () => mediaLibrary.listContinue());
  handle("prepareContinueMedia", (id) => mediaLibrary.resume(id));
  handle("getLocalSubtitle", (token, id) => localFiles.subtitle(token, id));
  handle("saveLocalPlayback", (token, data) =>
    localFiles.progress(token, data),
  );
  handle("releaseLocalMedia", (token) => localFiles.release(token));
  handle("getState", () => ({
    ...state,
    native: true,
    focused: win.isFocused(),
    platform: process.platform,
    packaged: app.isPackaged,
  }));
  handle("getSystem", () => ({
    platform: process.platform,
    version: os.release(),
    cpu: os.cpus()[0]?.model || "PC",
    memory: Math.round(os.totalmem() / 1024 ** 3),
    appVersion: app.getVersion(),
  }));
  updateSettings = async (patch) => {
    if (!patch || typeof patch !== "object")
      throw Error("Érvénytelen beállítás.");
    const next = { ...state.settings };
    for (const k of [
      "fullscreen",
      "startup",
      "minimizeOnLaunch",
      "sounds",
      "animations",
      "idleClock",
      "bootAnimation",
      "haptics",
      "batteryAlerts",
      "quietInGames",
      "largeText",
      "osk",
      "consoleMode",
      "overlayEnabled",
      "playtimeTracking",
      "modePicker",
      "modePickerSetup",
      "jarvisWindow",
      "consoleGuard",
      "fastSignIn",
      "hideTaskbar",
    ])
      if (k in patch) {
        if (typeof patch[k] !== "boolean")
          throw Error("Érvénytelen beállítás.");
        next[k] = patch[k];
      }
    for (const [key, min, max] of [
      ["controllerDeadzone", 20, 70],
      ["soundVolume", 0, 60],
      ["idleMinutes", 1, 60],
      ["controllerRepeatMs", 100, 300],
    ]) {
      if (key in patch) {
        if (
          !Number.isInteger(patch[key]) ||
          patch[key] < min ||
          patch[key] > max
        )
          throw Error("Érvénytelen kontrollerbeállítás.");
        next[key] = patch[key];
      }
    }
    if ("name" in patch) {
      if (
        typeof patch.name !== "string" ||
        !patch.name.trim() ||
        patch.name.length > 30
      )
        throw Error("A név 1–30 karakter lehet.");
      next.name = patch.name.trim();
    }
    if ("modeCountdown" in patch) {
      if (!modeCountdowns.includes(patch.modeCountdown))
        throw Error("Érvénytelen visszaszámlálás.");
      next.modeCountdown = patch.modeCountdown;
    }
    for (const key of ["defaultMode", "currentMode"])
      if (key in patch) {
        if (
          !modeIds.includes(patch[key]) &&
          !(key === "currentMode" && patch[key] === "")
        )
          throw Error("Ismeretlen mód.");
        next[key] = patch[key];
      }
    if ("jarvisPath" in patch) {
      if (
        typeof patch.jarvisPath !== "string" ||
        patch.jarvisPath.length > 1000 ||
        (patch.jarvisPath && !path.win32.isAbsolute(patch.jarvisPath))
      )
        throw Error("Érvénytelen Jarvis mappa.");
      next.jarvisPath = patch.jarvisPath;
    }
    if ("wallpaper" in patch) {
      if (!["forza", "ori", "plain"].includes(patch.wallpaper))
        throw Error("Ismeretlen háttér.");
      next.wallpaper = patch.wallpaper;
    }
    if ("startup" in patch) {
      requireWindows();
      if (!app.isPackaged)
        throw Error(
          "Az automatikus indulást a kicsomagolt Windowsos kiadásban állítsd be.",
        );
      app.setLoginItemSettings({
        openAtLogin: next.startup,
        path: process.execPath,
        args: ["--startup"],
      });
      const actual = app.getLoginItemSettings({
        path: process.execPath,
        args: ["--startup"],
      });
      if (actual.openAtLogin !== next.startup)
        throw Error(
          "A Windows nem engedte átállítani az automatikus indulást.",
        );
    }
    consolePolicy.normalizeSettings(next, patch);
    const previous = state.settings;
    state.settings = next;
    media?.settingsChanged();
    idleClock?.reset();
    if (consoleMode) {
      consoleMode.sync(previous);
      playtime?.settingsChanged(consoleMode.snapshot().session);
      if (!next.consoleMode || next.overlayEnabled === false) guide?.hide();
    } else if ("fullscreen" in patch)
      win.setFullScreen(consolePolicy.fullscreen(next));
    persist();
    return state.settings;
  };
  handle("saveSettings", updateSettings);
  handle("setFullscreen", async (on) => {
    if (typeof on !== "boolean") throw Error("Érvénytelen érték.");
    // Leaving fullscreen would also leave Konzol mode: that goes through the picker.
    if (!on && state.settings.consoleMode && modes) {
      modes.open({ preselect: "windows" });
      return true;
    }
    await updateSettings({
      fullscreen: on,
      ...(!on ? { consoleMode: false } : {}),
    });
    return on;
  });
  handle("getConsoleState", () => consoleMode.snapshot());
  handle("showConsole", () => {
    consoleMode.show();
    return true;
  });
  handle("resumeGame", () => consoleMode.resume());
  handle("openGameGuide", () => consoleMode.openGuide());
  handle("getPlaytime", () => playtime.snapshot());
  handle("enterDesktop", requestDesktop);
  handle("addFile", async () => {
    requireWindows();
    const r = await dialog.showOpenDialog(win, {
      title: "Játék vagy alkalmazás hozzáadása",
      properties: ["openFile"],
      filters: [
        { name: "Indítható fájlok", extensions: ["exe", "lnk", "url"] },
      ],
    });
    if (r.canceled) return null;
    const target = r.filePaths[0];
    return add({
      name: path.basename(target, path.extname(target)),
      type: "file",
      target,
    });
  });
  handle("listWindowsApps", async () => {
    const out = await powershell(
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-StartApps | Sort-Object Name | Select-Object Name,AppID) | ConvertTo-Json -Compress",
    );
    return out ? JSON.parse(out) : [];
  });
  handle("addWindowsApp", async (id) => {
    if (typeof id !== "string") throw Error("Érvénytelen alkalmazás.");
    const out = await powershell(
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-StartApps | Select-Object Name,AppID) | ConvertTo-Json -Compress",
    );
    const apps = JSON.parse(out || "[]");
    const found = apps.find((a) => a.AppID === id);
    if (!found) throw Error("Az alkalmazás már nem található.");
    return add({ name: found.Name, type: "windows", target: found.AppID });
  });
  handle("importSteam", async () => {
    requireWindows();
    const roots = new Set([
      path.join(
        process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
        "Steam",
      ),
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Steam"),
    ]);
    try {
      const p = await powershell(
        "(Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop).SteamPath",
      );
      if (p) roots.add(p);
    } catch {}
    for (const root of [...roots])
      try {
        for (const p of parseSteamLibraryPaths(
          fs.readFileSync(
            path.join(root, "steamapps", "libraryfolders.vdf"),
            "utf8",
          ),
        ))
          roots.add(p);
      } catch {}
    let added = 0,
      found = 0;
    for (const root of roots) {
      const dir = path.join(root, "steamapps");
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files.filter((f) => /^appmanifest_\d+\.acf$/.test(f))) {
        try {
          const g = parseSteamManifest(
            fs.readFileSync(path.join(dir, f), "utf8"),
          );
          if (g) {
            found++;
            const exists = state.games.some(
              (x) => x.type === "steam" && x.target === g.target,
            );
            add(g);
            if (!exists) added++;
          }
        } catch {}
      }
    }
    return { added, found };
  });
  handle("launchGame", async (id) => {
    requireWindows();
    const g = state.games.find((g) => g.id === id);
    if (!g) throw Error("A játék nem található.");
    validateGame(g);
    const current = consoleMode?.snapshot().session;
    if (current?.gameId === id && current.phase === "running") {
      await consoleMode.resume();
      return g;
    }
    if (pending.has(id)) throw Error("A játék indítása már folyamatban van.");
    pending.add(id);
    let tracked = null,
      launchedPid = 0;
    try {
      tracked = await consoleMode.prepare(g);
      const existing = consoleMode.snapshot().session;
      if (
        existing?.id === tracked &&
        existing.phase === "running" &&
        existing.canResume
      ) {
        await consoleMode.resume();
        return g;
      }
      if (g.type === "steam")
        await shell.openExternal("steam://rungameid/" + g.target);
      else if (g.type === "windows")
        await run("explorer.exe", ["shell:AppsFolder\\" + g.target], {
          windowsHide: true,
        });
      else {
        if (!fs.existsSync(g.target))
          throw Error(
            "Az indítófájl nem található. Vedd fel újra a játékot az új helyéről.",
          );
        if (path.extname(g.target).toLowerCase() === ".exe") {
          await new Promise((resolve, reject) => {
            const child = spawn(g.target, [], {
              cwd: path.dirname(g.target),
              detached: true,
              stdio: "ignore",
              windowsHide: false,
              shell: false,
            });
            child.once("error", reject);
            child.once("spawn", () => {
              launchedPid = child.pid;
              child.unref();
              resolve();
            });
          });
        } else {
          const error = await shell.openPath(g.target);
          if (error) throw Error(error);
        }
      }
      consoleMode.attached(tracked, launchedPid);
      g.lastPlayed = Date.now();
      g.launches = (g.launches || 0) + 1;
      state.history.unshift({ id: g.id, name: g.name, at: g.lastPlayed });
      state.history = state.history.slice(0, 100);
      persist();
      consoleMode.afterLaunch(tracked);
      return g;
    } catch (e) {
      consoleMode.launchFailed(tracked);
      throw e;
    } finally {
      setTimeout(() => pending.delete(id), 2500);
    }
  });
  handle("removeGame", (id) => {
    if (
      consoleMode.snapshot().session?.gameId === id &&
      ["running", "starting"].includes(consoleMode.snapshot().session.phase)
    )
      throw Error(
        "A futó játék parancsikonját a játék bezárása után távolíthatod el.",
      );
    state.games = state.games.filter((g) => g.id !== id);
    persist();
    return true;
  });
  handle("toggleFavorite", (id) => {
    const g = state.games.find((g) => g.id === id);
    if (!g) throw Error("A játék nem található.");
    g.favorite = !g.favorite;
    persist();
    return g;
  });
  handle("renameGame", (id, name) => {
    const g = state.games.find((g) => g.id === id);
    if (!g) throw Error("A játék nem található.");
    validateGame({ ...g, name });
    g.name = name.trim();
    persist();
    return g;
  });
  handle("setArtwork", (id) => artwork.set("game:" + id, "cover"));
  handle("setTileImage", (target, slot, reset = false) =>
    artwork.set(target, slot, reset),
  );
  handle("openStore", async (query = "") => {
    requireWindows();
    if (typeof query !== "string" || query.length > 150)
      throw Error("Túl hosszú keresés.");
    await shell.openExternal(
      query
        ? "ms-windows-store://search/?query=" + encodeURIComponent(query)
        : "ms-windows-store://home",
    );
    return true;
  });
  handle("openExternal", async (key) => {
    const urls = {
      cloud: "https://www.xbox.com/play",
      steam: "https://store.steampowered.com/",
      epic: "https://store.epicgames.com/",
      gamepass: "https://www.xbox.com/xbox-game-pass/pc-game-pass",
    };
    if (!urls[key]) throw Error("Ismeretlen hivatkozás.");
    await shell.openExternal(urls[key]);
    return true;
  });
  handle("systemSettings", async (key) => {
    requireWindows();
    const uris = {
      display: "ms-settings:display",
      audio: "ms-settings:sound",
      bluetooth: "ms-settings:bluetooth",
      network: "ms-settings:network-status",
      controller: "ms-settings:gaming-gamebar",
    };
    if (!uris[key]) throw Error("Ismeretlen beállítás.");
    await shell.openExternal(uris[key]);
    return true;
  });
  handle("minimize", requestDesktop);
  handle("close", () => {
    app.quit();
    return true;
  });
  handle("power", requestPower);
}
// In Konzol mode the way out to Windows leads through the mode picker.
async function requestDesktop() {
  if (state.settings.consoleMode && modes) {
    modes.open({ preselect: "windows" });
    return true;
  }
  return consoleMode.desktop();
}
async function requestPower(action) {
  requireWindows();
  if (!["shutdown", "restart", "sleep"].includes(action))
    throw Error("Ismeretlen művelet.");
  const labels = {
    shutdown: "leállítani",
    restart: "újraindítani",
    sleep: "alvó állapotba helyezni",
  };
  const r = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Mégse", "Igen, folytatom"],
    defaultId: 0,
    cancelId: 0,
    title: "NOVA · Energiagazdálkodás",
    message: "Biztosan szeretnéd " + labels[action] + " a számítógépet?",
    detail: "Előbb mentsd el a megnyitott munkáidat.",
  });
  if (r.response !== 1) return false;
  if (action === "sleep")
    await powershell(
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)",
    );
  else
    await run(
      "shutdown.exe",
      [action === "shutdown" ? "/s" : "/r", "/t", "0"],
      { windowsHide: true },
    );
  return true;
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv = []) => {
    if (modes && argv.includes("--mode-picker")) {
      modes.open();
      return;
    }
    // Two sign-in launches (e.g. Windows reopening NOVA and its autostart):
    // the --startup one decides at once, NOVA's console must not appear first.
    if (
      modes &&
      argv.includes("--startup") &&
      state.settings.modePicker !== false &&
      (modes.holdsMain() || modes.visible)
    ) {
      modes.boot();
      modes.open();
      return;
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    if (isWindows) app.setAppUserModelId("hu.nova.console");
    file = path.join(app.getPath("userData"), "library.json");
    state = loadState(file);
    if (isWindows && app.isPackaged)
      state.settings.startup = app.getLoginItemSettings({
        path: process.execPath,
        args: ["--startup"],
      }).openAtLogin;
    win = new BrowserWindow({
      width: 1500,
      height: 950,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: "#131313",
      title: "NOVA",
      icon: path.join(__dirname, "../dist/icon.png"),
      autoHideMenuBar: true,
      show: false,
      fullscreen:
        process.argv.includes("--startup") ||
        consolePolicy.fullscreen(state.settings),
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    localFiles = createLocalFiles({
      app,
      protocol,
      onProgress: (file, data) => mediaLibrary?.progress(file, data),
    });
    mediaLibrary = createMediaLibrary({
      app,
      localFiles,
      dialog,
      getWindow: () => win,
    });
    artwork = createArtwork({
      app,
      protocol,
      nativeImage,
      dialog,
      getWindow: () => win,
      getState: () => state,
      persist,
      isCustomTarget: (target) =>
        target.startsWith("cinema:") && mediaLibrary.hasTitle(target.slice(7)),
    });
    setup();
    playtime = createPlaytimeTracker({
      getState: () => state,
      persist,
      onChange: (value) => {
        if (!win.isDestroyed()) win.webContents.send("nova:playtime", value);
        guide?.publish();
      },
    });
    const shouldNotifyBattery = createBatteryNotice();
    function showBattery() {
      if (!state.settings.batteryAlerts) return;
      const message =
        "A kontroller akkumulátora alacsony. Hamarosan töltsd fel vagy cserélj elemet.";
      if (win.isFocused()) {
        win.webContents.send("nova:media-notice", message);
        batteryPending = false;
      } else if (!state.settings.quietInGames && Notification.isSupported()) {
        new Notification({
          title: "NOVA · Kontroller",
          body: message,
          silent: true,
        }).show();
        batteryPending = false;
      } else batteryPending = true;
    }
    win.on("focus", () => {
      if (batteryPending) showBattery();
    });
    consoleMode = createConsoleMode({
      app,
      window: win,
      getSettings: () => state.settings,
      setMode: (enabled) => updateSettings({ consoleMode: enabled }),
      beforeHome: () => {
        idleClock?.reset();
        media?.suspend();
        guide?.hide();
        playtime?.pause();
      },
      onSession: (session, phase) => {
        if (phase === "running") playtime.start(session);
        else if (
          [
            "ended",
            "error",
            "failed",
            "switched",
            "disabled",
            "untracked",
          ].includes(phase)
        )
          playtime.finish(phase);
        if (phase === "ended" || phase === "error") guide?.hide();
        guide?.publish();
      },
      onActivity: (id, active) =>
        playtime.pulse(id, active && !idleClock?.visible),
      onGuide: (bounds) => {
        media?.suspend();
        playtime.pause();
        guide
          ?.show(bounds)
          .catch((e) => win.webContents.send("nova:media-notice", e.message));
      },
      onInput: (message) => {
        if (message.surface === "guide") guide?.input(message);
        else if (!win.isDestroyed() && win.isVisible() && win.isFocused())
          win.webContents.send("nova:controller-input", message);
      },
      onIdle: (ms) => idleClock?.padIdle(ms),
      onMediaHome: () => media?.home(),
      onModePicker: () => modes?.open(),
      requestDesktop,
      // The picker owns the screen while it is open or a sign-in choice is pending.
      guardPaused: () => !!modes && (modes.visible || modes.holdsMain()),
      // No Windows taskbar over the picker or Konzol mode.
      taskbarHidden: () =>
        state.settings.hideTaskbar !== false &&
        (!!state.settings.consoleMode ||
          (!!modes && (modes.visible || modes.holdsMain()))),
      onPad: (pad) => {
        if (shouldNotifyBattery(pad)) showBattery();
        if (!win.isDestroyed())
          win.webContents.send("nova:controller-state", pad);
        guide?.pad(pad);
      },
      onAudio: (audio) => guide?.audio(audio),
    });
    media = createMediaIntegration({
      app,
      mainWindow: win,
      getSettings: () => state.settings,
      onControlActive: (value) => {
        if (value) guide?.hide();
        consoleMode.setMediaActive(value);
      },
      focusMain: () => consoleMode.returnFromMedia(),
      backgroundMain: () => consoleMode.prepareMedia(),
    });
    guide = createGameGuide({
      mainWindow: win,
      getConsole: () => consoleMode.snapshot(),
      getSettings: () => state.settings,
      getPlaytime: () => playtime.snapshot(),
      getGame: (id) => state.games.find((g) => g.id === id),
      command: (cmd) => consoleMode.command(cmd),
      resume: () => consoleMode.resume(),
      closeGame: (id) => consoleMode.closeGame(id),
      sleep: () => requestPower("sleep"),
      showMain: (page) => {
        consoleMode.showDashboard();
        win.webContents.send("nova:navigate", page);
      },
      desktop: () => requestDesktop(),
    });
    idleClock = createIdleClock({
      BrowserWindow,
      screen,
      powerMonitor,
      getSettings: () => state.settings,
      mediaOpen: () => !!media?.snapshot().active || localFiles.hasOpenMedia(),
      onChange: (visible) => {
        if (visible) playtime.pause();
      },
    });
    const services = createServices({
      run,
      spawn,
      openPath: (file) => shell.openPath(file),
      backupDir: path.join(app.getPath("userData"), "startup-backup"),
    });
    let mainReady = false;
    modes = createModeManager({
      BrowserWindow,
      ipcMain,
      screen,
      dialog,
      globalShortcut,
      services,
      getSettings: () => state.settings,
      saveSettings: (patch) => updateSettings(patch),
      enterConsole: async () => {
        await updateSettings({ consoleMode: true });
        consoleMode.showDashboard();
      },
      enterDesktop: () => consoleMode.desktop(),
      showMain: () => {
        // Before the first paint ready-to-show shows the window itself.
        if (win.isDestroyed() || !mainReady) return;
        win.show();
        win.focus();
      },
      onApplied: (mode) => {
        if (mode === "console" && !win.isDestroyed()) consoleMode.showDashboard();
      },
      onVisible: (visible) => {
        if (visible) idleClock?.reset();
        consoleMode.refreshConfig();
      },
      focusNative: (target) => {
        if (!isWindows || target.isDestroyed()) return;
        const handle = target.getNativeWindowHandle();
        const pointer =
          handle.length >= 8
            ? handle.readBigUInt64LE(0).toString()
            : String(handle.readUInt32LE(0));
        try {
          consoleMode.command("focus|" + pointer);
        } catch {}
      },
    });
    let recoveryGeneration = 0,
      systemSuspended = false;
    function recover(unlock = true) {
      if (!unlock && systemSuspended) return;
      systemSuspended = false;
      const generation = ++recoveryGeneration;
      consoleMode.suspend(false);
      idleClock.suspend(false);
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(async () => {
        if (win.isDestroyed()) return;
        await consoleMode.recover().catch(() => false);
        if (
          generation !== recoveryGeneration ||
          systemSuspended ||
          win.isDestroyed()
        )
          return;
        const bounds = win.getBounds(),
          display = screen.getDisplayMatching(bounds);
        if (
          !screen
            .getAllDisplays()
            .some(
              (d) =>
                bounds.x < d.workArea.x + d.workArea.width &&
                bounds.x + bounds.width > d.workArea.x &&
                bounds.y < d.workArea.y + d.workArea.height &&
                bounds.y + bounds.height > d.workArea.y,
            )
        ) {
          win.setBounds({
            ...bounds,
            x: display.workArea.x,
            y: display.workArea.y,
            width: Math.min(bounds.width, display.workArea.width),
            height: Math.min(bounds.height, display.workArea.height),
          });
        }
        if (!win.isDestroyed()) {
          win.webContents.send("nova:window-active", win.isFocused());
          win.webContents.send("nova:recovered");
        }
      }, 1200);
    }
    screen.on("display-removed", () => recover(false));
    screen.on("display-metrics-changed", () => recover(false));
    for (const event of ["suspend", "lock-screen"])
      powerMonitor.on(event, () => {
        systemSuspended = true;
        recoveryGeneration++;
        clearTimeout(recoveryTimer);
        idleClock.suspend(true);
        playtime.pause();
        consoleMode.suspend(true);
        guide.hide();
      });
    for (const event of ["resume", "unlock-screen"])
      powerMonitor.on(event, () => recover(true));
    for (const event of ["focus", "blur", "minimize", "restore"])
      win.on(event, () => {
        if (!win.isDestroyed())
          win.webContents.send("nova:window-active", win.isFocused());
      });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    win.once("ready-to-show", () => {
      mainReady = true;
      if (!modes.holdsMain()) win.show();
    });
    win.once("closed", () => app.quit());
    let mainLoaded = false;
    const loadMain = () => {
      if (mainLoaded || win.isDestroyed()) return;
      mainLoaded = true;
      win.loadFile(path.join(__dirname, "../dist/index.html"));
    };
    // NOVA 1.11: the mode picker greets every sign-in, so NOVA has to start with Windows.
    if (isWindows && app.isPackaged && !state.settings.modePickerSetup)
      updateSettings({ startup: true, modePickerSetup: true }).catch(() => {});
    const flags = process.argv.slice(1).filter((arg) => arg.startsWith("--"));
    const shown = flags.length ? flags.join(" ") : "kapcsoló nélkül";
    const pickerOn = state.settings.modePicker !== false;
    if (flags.includes("--mode-picker")) {
      modes.open({ hold: true });
      startupLog(`indulás (${shown}): módválasztó parancsikonról`);
    } else if (pickerOn && flags.includes("--startup")) {
      // The picker gets the machine first; the heavier NOVA main menu loads behind it.
      modes.boot();
      setTimeout(loadMain, 1500);
      startupLog(`indulás (${shown}): módválasztó visszaszámlálással`);
    } else if (pickerOn && isWindows) {
      // Started at sign-in some other way (Startup shortcut, Task Scheduler,
      // Windows reopening apps)? NOVA stays hidden until that is known.
      modes.hold();
      consoleMode.refreshConfig();
      services.sessionAge().then((age) => {
        const signIn = age !== null && age < SIGN_IN_WINDOW_MS;
        startupLog(
          `indulás (${shown}): bejelentkezés óta ${age === null ? "ismeretlen idő" : Math.round(age / 1000) + " mp"}, ` +
            (signIn ? "módválasztó visszaszámlálással" : "NOVA főmenü"),
        );
        if (signIn) modes.boot();
        else modes.release();
        consoleMode.refreshConfig();
      });
    } else
      startupLog(
        `indulás (${shown}): ${pickerOn ? "NOVA főmenü" : "a módválasztó ki van kapcsolva"}`,
      );
    if (!flags.includes("--startup") || !pickerOn) loadMain();
    // Programs started at sign-in run without Windows' startup delay (switchable in the picker).
    if (isWindows && state.settings.fastSignIn !== false)
      services
        .signInSnapshot()
        .then((current) => (current.fastStartup ? null : services.setFastStartup(true)))
        .catch(() => {});
    // A fullscreen window can become visible on creation; keep it behind the picker until a choice.
    if (modes.holdsMain() && win.isVisible()) win.hide();
    win.webContents.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        input.key === "F11" &&
        !input.isAutoRepeat
      ) {
        event.preventDefault();
        if (state.settings.consoleMode) {
          modes.open({ preselect: "windows" });
          return;
        }
        updateSettings({
          fullscreen: !win.isFullScreen(),
          ...(state.settings.consoleMode ? { consoleMode: false } : {}),
        }).catch(() => {});
      }
    });
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    clearTimeout(recoveryTimer);
    modes?.dispose();
    idleClock?.dispose();
    playtime?.dispose();
    guide?.dispose();
    consoleMode?.dispose();
    media?.dispose();
    localFiles?.dispose();
  });
}
