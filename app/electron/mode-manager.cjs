// NOVA mode picker: Konzol / Jarvis / Windows.
// At sign-in the picker counts down to the default mode (Jarvis), so a remote
// power-on still ends up working. A later choice always replaces the earlier one.
const path = require("node:path");

const MODES = ["console", "jarvis", "windows"];
const COUNTDOWNS = [10, 15, 20, 30, 45, 60, 90, 120];
const HOTKEY = "Control+Alt+M";
const BOOT_ENFORCE_MS = 180000;
const PLANS = {
  console: [
    ["jarvis-stop", "Jarvis leállítása"],
    ["ollama-stop", "Ollama leállítása"],
    ["nova-console", "Konzol mód indítása"],
  ],
  jarvis: [
    ["ollama-start", "Ollama indítása"],
    ["jarvis-start", "Jarvis indítása"],
    ["nova-desktop", "NOVA a háttérbe"],
  ],
  windows: [
    ["jarvis-stop", "Jarvis leállítása"],
    ["ollama-stop", "Ollama leállítása"],
    ["nova-desktop", "Váltás a Windows asztalra"],
  ],
};

function validModePatch(patch) {
  if (!patch || typeof patch !== "object") throw Error("Érvénytelen beállítás.");
  const next = {};
  for (const key of ["modePicker", "jarvisWindow", "consoleGuard", "fastSignIn"])
    if (key in patch) {
      if (typeof patch[key] !== "boolean") throw Error("Érvénytelen beállítás.");
      next[key] = patch[key];
    }
  if ("modeCountdown" in patch) {
    if (!COUNTDOWNS.includes(patch.modeCountdown))
      throw Error("Érvénytelen visszaszámlálás.");
    next.modeCountdown = patch.modeCountdown;
  }
  if ("defaultMode" in patch) {
    if (!MODES.includes(patch.defaultMode)) throw Error("Ismeretlen mód.");
    next.defaultMode = patch.defaultMode;
  }
  return next;
}

function createModeManager({
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  globalShortcut,
  services,
  getSettings,
  saveSettings,
  enterConsole,
  enterDesktop,
  showMain = () => {},
  onApplied = () => {},
  onVisible = () => {},
  focusNative = () => {},
  registerHotkey = process.platform === "win32",
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRepeat = setInterval,
  clearRepeat = clearInterval,
}) {
  let picker = null,
    reason = "manual",
    preselect = null,
    countdown = null,
    countdownTimer = null,
    countdownCancelled = false,
    job = null,
    generation = 0,
    chain = Promise.resolve(),
    holdMain = false,
    ending = false,
    status = { ollama: null, jarvis: null },
    statusTimer = null,
    statusBusy = false,
    jarvisDir = "",
    searched = false,
    startup = { ollama: false, jarvis: false, saved: [] },
    bootAt = 0,
    booted = false,
    signIn = { autoLogon: null, fastStartup: null },
    signInChecked = false,
    enforceTimer = null,
    hotkey = false,
    disposed = false;

  const settings = () => getSettings();
  const wait = (ms) => new Promise((resolve) => setTimer(resolve, ms));

  function snapshot() {
    const s = settings();
    return {
      reason,
      preselect,
      current: MODES.includes(s.currentMode) ? s.currentMode : null,
      available: services.available,
      countdown: countdown
        ? {
            mode: countdown.mode,
            total: countdown.total,
            remaining: Math.max(0, countdown.deadline - now()),
          }
        : null,
      countdownCancelled,
      job: job
        ? {
            id: job.gen,
            mode: job.mode,
            steps: job.steps.map((step) => ({ ...step })),
            error: job.error,
            done: job.done,
          }
        : null,
      settings: {
        modePicker: s.modePicker !== false,
        modeCountdown: s.modeCountdown,
        defaultMode: s.defaultMode,
        jarvisWindow: s.jarvisWindow !== false,
        consoleGuard: s.consoleGuard !== false,
        jarvisPath: s.jarvisPath || "",
      },
      jarvisDir,
      startup,
      signIn,
      services: status,
      profile: s.name,
      animations: s.animations !== false,
      sounds: s.sounds !== false,
      soundVolume: s.soundVolume,
      hotkey: "Ctrl+Alt+M",
    };
  }

  function publish() {
    if (picker && !picker.isDestroyed())
      picker.webContents.send("nova-picker:update", snapshot());
  }

  // Looks for the Jarvis folder once per picker visit and remembers a find.
  async function resolveJarvis(force = false) {
    const configured = settings().jarvisPath;
    if (services.validJarvisDir(configured)) return (jarvisDir = configured);
    if (jarvisDir && services.validJarvisDir(jarvisDir)) return jarvisDir;
    if (searched && !force) return "";
    searched = true;
    jarvisDir = await services.findJarvis("");
    if (jarvisDir) await saveSettings({ jarvisPath: jarvisDir }).catch(() => {});
    return jarvisDir;
  }

  async function refreshStatus() {
    if (statusBusy || disposed) return;
    statusBusy = true;
    try {
      const [next] = await Promise.all([
        services.status().catch(() => ({ ollama: null, jarvis: null })),
        resolveJarvis().catch(() => ""),
      ]);
      status = next;
      startup = services.startupSnapshot();
      if (!signInChecked) {
        signInChecked = true;
        signIn = await services.signInSnapshot().catch(() => signIn);
      }
    } finally {
      statusBusy = false;
    }
    publish();
  }

  function stopCountdown() {
    if (countdownTimer) clearTimer(countdownTimer);
    countdownTimer = null;
    countdown = null;
  }

  function startCountdown(seconds, mode) {
    stopCountdown();
    countdownCancelled = false;
    countdown = { mode, total: seconds * 1000, deadline: now() + seconds * 1000 };
    countdownTimer = setTimer(() => {
      countdownTimer = null;
      countdown = null;
      apply(mode).catch(() => {});
    }, seconds * 1000);
  }

  function cancelCountdown() {
    if (!countdown) return false;
    stopCountdown();
    countdownCancelled = true;
    publish();
    return true;
  }

  function destroyPicker() {
    const old = picker;
    picker = null;
    if (statusTimer) clearRepeat(statusTimer);
    statusTimer = null;
    if (old && !old.isDestroyed()) old.destroy();
    onVisible(false);
  }

  function close() {
    if (!picker) return true;
    if (job && !job.done && !job.error) return false;
    // At sign-in a mode has to be chosen; the countdown keeps the default.
    if (reason === "boot" && holdMain) return false;
    if (job && (job.done || job.error)) job = null;
    destroyPicker();
    if (holdMain) {
      holdMain = false;
      showMain();
    }
    return true;
  }

  function open(options = {}) {
    if (disposed) return null;
    if (options.preselect && MODES.includes(options.preselect))
      preselect = options.preselect;
    if (picker && !picker.isDestroyed()) {
      if (picker.isMinimized()) picker.restore();
      picker.show();
      picker.focus();
      publish();
      return picker;
    }
    reason = options.reason === "boot" ? "boot" : "manual";
    if (options.hold) holdMain = true;
    if (!options.preselect) preselect = null;
    if (job?.done) job = null;
    searched = false;
    signInChecked = false;
    const display =
      reason === "boot"
        ? screen.getPrimaryDisplay()
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      fullscreen: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: "#09090a",
      title: "NOVA · Mód választása",
      icon: path.join(__dirname, "../dist/icon.png"),
      webPreferences: {
        preload: path.join(__dirname, "mode-preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    picker = win;
    win.setMenu(null);
    win.setAlwaysOnTop(true, "screen-saver");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _p, callback) =>
      callback(false),
    );
    // Never hold up a Windows sign-out or shutdown.
    win.on("session-end", () => {
      ending = true;
    });
    win.on("close", (event) => {
      if (picker === win && !ending && !close()) event.preventDefault();
    });
    win.on("closed", () => {
      if (picker === win) {
        picker = null;
        if (statusTimer) clearRepeat(statusTimer);
        statusTimer = null;
        onVisible(false);
      }
    });
    // Topmost is lifted while a Windows dialog of another program is open.
    win.on("focus", () => {
      if (!win.isDestroyed() && !win.isAlwaysOnTop())
        win.setAlwaysOnTop(true, "screen-saver");
    });
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      win.webContents.focus();
      // Windows may refuse focus to a new window over a game; NOVA's helper can take it.
      focusNative(win);
    });
    win
      .loadFile(path.join(__dirname, "mode-picker.html"))
      .catch(() => {
        // The countdown in the main process still applies the default mode.
        if (picker === win && reason !== "boot") destroyPicker();
      });
    statusTimer = setRepeat(() => refreshStatus().catch(() => {}), 3000);
    onVisible(true);
    refreshStatus().catch(() => {});
    return win;
  }

  async function runStep(id, current) {
    const s = settings();
    const signal = {
      get aborted() {
        return current.gen !== generation || disposed;
      },
    };
    const skip = (note) => ({ skip: true, note });
    if (id === "nova-console") {
      await enterConsole();
      return { note: "" };
    }
    if (id === "nova-desktop") {
      await enterDesktop();
      return { note: "" };
    }
    if (!services.available) return skip("csak Windowson");
    if (id === "jarvis-stop") {
      const dir = await resolveJarvis().catch(() => "");
      const r = await services.stopJarvis({ dir });
      return r.stopped
        ? { note: r.forced ? "kényszerítve leállítva" : "leállítva" }
        : skip("nem futott");
    }
    if (id === "ollama-stop") {
      const r = await services.stopOllama();
      return r.stopped ? { note: "leállítva" } : skip("nem futott");
    }
    if (id === "ollama-start") {
      const r = await services.startOllama({ signal });
      return r.started ? { note: "elindult" } : skip("már futott");
    }
    if (id === "jarvis-start") {
      const dir = await resolveJarvis(true);
      const r = await services.startJarvis({
        dir,
        window: s.jarvisWindow !== false,
        signal,
      });
      return r.started
        ? { note: "elindult" }
        : skip(r.status === "standby" ? "már fut (készenlétben)" : "már futott");
    }
    throw Error("Ismeretlen lépés.");
  }

  async function runJob(current) {
    let step = null;
    try {
      for (step of current.steps) {
        if (current.gen !== generation || disposed) return false;
        step.state = "run";
        publish();
        const result = await runStep(step.id, current);
        step.state = result.skip ? "skip" : "done";
        step.note = result.note || "";
        publish();
      }
      if (current.gen !== generation || disposed) return false;
      await saveSettings({ currentMode: current.mode });
      current.done = true;
      holdMain = false;
      publish();
      armEnforcement(current);
      refreshStatus().catch(() => {});
      await wait(900);
      if (current.gen === generation && job === current) {
        if (picker) destroyPicker();
        onApplied(current.mode);
      }
      return true;
    } catch (e) {
      if (current.gen !== generation) return false;
      if (step) step.state = "error";
      current.error = e?.message || "A váltás nem sikerült.";
      publish();
      if (!picker) open({ preselect: current.mode });
      return false;
    }
  }

  function apply(mode) {
    if (!MODES.includes(mode)) return Promise.reject(Error("Ismeretlen mód."));
    stopCountdown();
    if (enforceTimer) clearRepeat(enforceTimer);
    enforceTimer = null;
    const current = {
      mode,
      gen: ++generation,
      steps: PLANS[mode].map(([id, label]) => ({ id, label, state: "wait", note: "" })),
      error: null,
      done: false,
    };
    job = current;
    preselect = mode;
    publish();
    const result = chain.then(() => runJob(current));
    chain = result.catch(() => false);
    return result;
  }

  // Ollama's and Jarvis's own Startup shortcuts may launch after the choice
  // was made at sign-in. For a few minutes, stop them again in Konzol / Windows.
  function armEnforcement(current) {
    if (!bootAt || current.mode === "jarvis" || !services.available) return;
    const items = services.startupSnapshot();
    if (!items.ollama && !items.jarvis) return;
    const until = bootAt + BOOT_ENFORCE_MS;
    let busy = false;
    enforceTimer = setRepeat(async () => {
      if (current.gen !== generation || now() > until || disposed) {
        clearRepeat(enforceTimer);
        enforceTimer = null;
        return;
      }
      if (busy) return;
      busy = true;
      try {
        const live = await services.status();
        if (current.gen !== generation) return;
        if (items.jarvis && live.jarvis && live.jarvis !== "stopped")
          await services.stopJarvis({ dir: jarvisDir }).catch(() => {});
        if (items.ollama && live.ollama) await services.stopOllama().catch(() => {});
      } finally {
        busy = false;
      }
    }, 5000);
  }

  function boot() {
    // Once per NOVA start: a second sign-in launch only brings the picker forward.
    if (booted) return;
    booted = true;
    const s = settings();
    bootAt = now();
    holdMain = true;
    const seconds = COUNTDOWNS.includes(s.modeCountdown) ? s.modeCountdown : 30;
    const mode = MODES.includes(s.defaultMode) ? s.defaultMode : "jarvis";
    startCountdown(seconds, mode);
    try {
      open({ reason: "boot", preselect: mode });
    } catch {}
  }

  function handle(name, fn) {
    ipcMain.handle("nova-picker:" + name, async (event, ...args) => {
      if (!picker || picker.isDestroyed() || event.sender !== picker.webContents)
        return { ok: false, error: "Tiltott hívás." };
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e?.message || "A művelet nem sikerült." };
      }
    });
  }

  const channels = [];
  function register(name, fn) {
    channels.push("nova-picker:" + name);
    handle(name, fn);
  }
  register("state", () => snapshot());
  register("choose", (mode) => {
    if (!MODES.includes(mode)) throw Error("Ismeretlen mód.");
    // A later choice wins; the running step stops at its next check.
    if (job && !job.done && !job.error && job.mode === mode) return true;
    apply(mode).catch(() => {});
    return true;
  });
  register("retry", () => {
    if (!job?.error) return false;
    apply(job.mode).catch(() => {});
    return true;
  });
  register("cancel-countdown", () => cancelCountdown());
  register("close", () => close());
  register("save", async (patch) => {
    await saveSettings(validModePatch(patch));
    publish();
    return snapshot().settings;
  });
  register("browse-jarvis", async () => {
    const result = await dialog.showOpenDialog(picker, {
      title: "A Jarvis mappája (amelyikben a jarvis.py van)",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    const dir = result.filePaths[0];
    if (!services.validJarvisDir(dir))
      throw Error("Ebben a mappában nincs jarvis.py. A Jarvis fő mappáját válaszd.");
    await saveSettings({ jarvisPath: dir });
    jarvisDir = dir;
    publish();
    return dir;
  });
  register("startup-takeover", () => {
    startup = services.startupTakeover();
    publish();
    return startup;
  });
  register("startup-restore", () => {
    startup = services.startupRestore();
    publish();
    return startup;
  });
  register("fast-sign-in", async (on) => {
    if (typeof on !== "boolean") throw Error("Érvénytelen beállítás.");
    const fast = await services.setFastStartup(on);
    await saveSettings({ fastSignIn: on });
    signIn = { ...signIn, fastStartup: fast };
    publish();
    return fast;
  });
  register("auto-logon", async () => {
    // netplwiz would open behind the topmost picker.
    if (picker && !picker.isDestroyed()) picker.setAlwaysOnTop(false);
    try {
      await services.openAutoLogon();
    } catch (e) {
      if (picker && !picker.isDestroyed()) picker.setAlwaysOnTop(true, "screen-saver");
      throw e;
    }
    signInChecked = false;
    return true;
  });

  if (registerHotkey)
    try {
      hotkey = globalShortcut.register(HOTKEY, () => open());
    } catch {}

  return {
    boot,
    open,
    close,
    apply,
    snapshot,
    holdsMain: () => holdMain,
    // Keeps NOVA's main window hidden while the sign-in check runs.
    hold() {
      if (!picker) holdMain = true;
    },
    release() {
      if (!holdMain || picker) return;
      holdMain = false;
      showMain();
    },
    get visible() {
      return !!picker && !picker.isDestroyed();
    },
    dispose() {
      disposed = true;
      stopCountdown();
      if (enforceTimer) clearRepeat(enforceTimer);
      if (hotkey) globalShortcut.unregister(HOTKEY);
      hotkey = false;
      for (const channel of channels) ipcMain.removeHandler(channel);
      destroyPicker();
    },
  };
}

module.exports = { createModeManager, validModePatch, MODES, COUNTDOWNS, PLANS };
