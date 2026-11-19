const { globalShortcut, Tray, Menu, nativeImage } = require("electron");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createInterface } = require("node:readline");
const policy = require("./console-policy.cjs");
const run = promisify(execFile);
const HOTKEY = "Control+Alt+N";
function createConsoleMode({
  app,
  window: win,
  getSettings,
  setMode,
  beforeHome = () => {},
  onSession = () => {},
  onActivity = () => {},
  onGuide = () => {},
  onInput = () => {},
  onPad = () => {},
  onAudio = () => {},
  onIdle = () => {},
  onMediaHome = () => {},
  onModePicker = () => {},
  requestDesktop = null,
  guardPaused = () => false,
  taskbarHidden = () => false,
}) {
  let helper,
    reader,
    tray,
    registered = false,
    enabled = false,
    mediaActive = false,
    disposed = false,
    suspended = false,
    readyTimer,
    returnTimer,
    recoveryTask,
    lastHeartbeat = -Infinity,
    trackedTarget = null,
    trackedPid = null,
    minimizedForGame = null;
  let helperState = "off",
    session = null,
    error = null;
  let controller = { connected: false },
    resumeSequence = 0;
  const resumeWaiters = new Map(),
    closeWaiters = new Map();
  const readyWaiters = new Set(),
    watchWaiters = new Map();
  function snapshot() {
    return {
      enabled,
      nativeInput: helperState === "ready",
      controller: { ...controller },
      helper: helperState,
      session: session ? { ...session } : null,
      hotkey: registered,
      error,
    };
  }
  function publish() {
    if (!win.isDestroyed()) win.webContents.send("nova:console", snapshot());
    updateTray();
  }
  function notice(message) {
    if (!win.isDestroyed()) win.webContents.send("nova:media-notice", message);
  }
  function write(command) {
    if (!helper || helper.killed || !helper.stdin.writable)
      throw Error("A visszatérés figyelése jelenleg nem érhető el.");
    helper.stdin.write(command + "\n");
  }
  function show(quick = true) {
    if (disposed || win.isDestroyed()) return;
    beforeHome();
    if (win.isMinimized()) win.restore();
    if (enabled) win.setFullScreen(true);
    win.show();
    win.focus();
    if (quick) win.webContents.send("nova:show-console");
  }
  function requestHome() {
    if (mediaActive) {
      onMediaHome();
      return;
    }
    if (enabled && helperState === "ready") {
      try {
        write("home");
        return;
      } catch {}
    }
    show(true);
  }
  function requestGuide() {
    if (mediaActive) {
      requestHome();
      return true;
    }
    if (
      enabled &&
      getSettings().overlayEnabled !== false &&
      session &&
      helperState === "ready"
    ) {
      write("guide");
      return true;
    }
    requestHome();
    return true;
  }
  function config() {
    if (helper)
      try {
        write("feedback|" + (getSettings().haptics ? "1" : "0"));
      } catch {}
    if (helper)
      try {
        write(
          [
            "config",
            enabled ? 1 : 0,
            getSettings().overlayEnabled === false ? 0 : 1,
            getSettings().controllerDeadzone ?? 35,
            getSettings().controllerRepeatMs ?? 160,
          ].join("|"),
        );
      } catch {}
    if (helper)
      try {
        // View + Menu held for 3 s opens the mode picker in every mode.
        write("picker|1");
        write(
          "guard|" +
            (getSettings().consoleGuard === false || guardPaused() ? 0 : 1),
        );
        write("taskbar|" + (taskbarHidden() ? 1 : 0));
      } catch {}
  }
  function syncHotkey() {
    if (process.platform !== "win32") return;
    if ((enabled || mediaActive) && !registered)
      try {
        registered = globalShortcut.register(HOTKEY, requestGuide);
      } catch {}
    else if (!enabled && !mediaActive && registered) {
      globalShortcut.unregister(HOTKEY);
      registered = false;
    }
  }
  async function desktop() {
    minimizedForGame = null;
    await setMode(false);
    beforeHome();
    if (!win.isDestroyed()) win.minimize();
    return true;
  }
  function updateTray() {
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Mód választása…  (Ctrl+Alt+M)", click: () => onModePicker() },
        { type: "separator" },
        { label: "NOVA főmenü", click: requestHome },
        {
          label: "Konzol mód",
          type: "checkbox",
          checked: enabled,
          click: (item) => {
            Promise.resolve(setMode(item.checked)).catch((e) =>
              notice(e.message),
            );
          },
        },
        {
          label: "Windows mód",
          click: () =>
            Promise.resolve((requestDesktop || desktop)()).catch((e) =>
              notice(e.message),
            ),
        },
        { type: "separator" },
        { label: "Kilépés a NOVA-ból", click: () => app.quit() },
      ]),
    );
    tray.setToolTip(enabled ? "NOVA · Konzol mód" : "NOVA · Windows mód");
  }
  function settleReady(value) {
    for (const resolve of readyWaiters) resolve(value);
    readyWaiters.clear();
  }
  function stop() {
    controller = { connected: false, nativeInput: false };
    onPad(controller);
    clearTimeout(readyTimer);
    settleReady(false);
    for (const resolve of resumeWaiters.values()) resolve(false);
    resumeWaiters.clear();
    for (const resolve of closeWaiters.values()) resolve(false);
    closeWaiters.clear();
    for (const resolve of watchWaiters.values()) resolve(false);
    watchWaiters.clear();
    if (reader) {
      reader.close();
      reader = null;
    }
    if (helper) {
      const old = helper;
      helper = null;
      try {
        old.stdin.write("taskbar|0\n");
        old.stdin.write("stop\n");
        old.stdin.end();
      } catch {}
      const timer = setTimeout(() => {
        if (old.exitCode === null) old.kill();
      }, 1500);
      timer.unref();
    }
    helperState = "off";
  }
  function receive(msg) {
    if (disposed || !msg || typeof msg.type !== "string") return;
    if (msg.type === "ready") {
      clearTimeout(readyTimer);
      helperState = "ready";
      lastHeartbeat = performance.now();
      error = null;
      settleReady(true);
      config();
      try {
        write("media-active|" + (mediaActive ? 1 : 0));
      } catch {}
      publish();
    } else if (
      msg.type === "idle" &&
      Number.isFinite(msg.idleMs) &&
      msg.idleMs >= 0
    ) {
      lastHeartbeat = performance.now();
      onIdle(msg.idleMs);
    } else if (msg.type === "pad" && typeof msg.connected === "boolean") {
      controller = {
        connected: msg.connected,
        index: msg.index,
        power: msg.power,
        battery: msg.battery,
        buttons: msg.buttons,
        lx: msg.lx,
        ly: msg.ly,
        nativeInput: true,
      };
      onPad(controller);
    } else if (
      msg.type === "input" &&
      ["dashboard", "guide"].includes(msg.surface) &&
      [
        "up",
        "down",
        "left",
        "right",
        "select",
        "back",
        "x",
        "y",
        "menu",
        "home",
        "prev",
        "next",
      ].includes(msg.action)
    ) {
      onInput(msg);
    } else if (msg.type === "audio") onAudio(msg);
    else if (msg.type === "activity" && session?.id === msg.id)
      onActivity(msg.id, msg.active === true);
    else if (msg.type === "guide" && enabled) onGuide(msg.bounds);
    else if (msg.type === "resumed" && Number.isSafeInteger(msg.request)) {
      resumeWaiters.get(msg.request)?.(msg.ok === true);
      resumeWaiters.delete(msg.request);
    } else if (
      msg.type === "game-close-requested" &&
      Number.isSafeInteger(msg.request)
    ) {
      closeWaiters.get(msg.request)?.(msg.ok === true);
      closeWaiters.delete(msg.request);
    } else if (msg.type === "watching") {
      watchWaiters.get(msg.id)?.(true);
      watchWaiters.delete(msg.id);
    } else if (msg.type === "media-home" && mediaActive) onMediaHome();
    else if (msg.type === "mode-picker") onModePicker();
    else if (
      msg.type === "guard-home" &&
      enabled &&
      !guardPaused() &&
      !mediaActive &&
      !suspended &&
      !session
    )
      show(false);
    else if (msg.type === "home" && enabled) show(true);
    else if (
      msg.type === "session" &&
      session?.id === msg.id &&
      ["starting", "running", "ended", "untracked"].includes(msg.phase)
    ) {
      session = { ...session, phase: msg.phase, canResume: !!msg.canResume };
      onSession(session, msg.phase);
      publish();
      if (msg.phase === "ended") {
        const shouldReturn =
          (enabled || minimizedForGame === msg.id) &&
          !mediaActive && !suspended && msg.returnToMenu !== false;
        minimizedForGame = null;
        session = null;
        publish();
        if (shouldReturn && !win.isDestroyed()) {
          show(false);
          if (win.isFocused?.() === false) {
            try {
              write("main");
            } catch {}
          }
          win.webContents.focus?.();
          resetDashboardInput();
        }
      }
    } else if (msg.type === "notice" && typeof msg.message === "string")
      notice(msg.message);
    else if (msg.type === "error") {
      error =
        typeof msg.message === "string"
          ? msg.message
          : "Az automatikus visszatérés jelenleg nem érhető el.";
      helperState = "error";
      controller = { connected: false, nativeInput: false };
      onPad(controller);
      if (session) onSession(session, "error");
      clearTimeout(readyTimer);
      settleReady(false);
      notice(error);
      publish();
    }
  }
  function start() {
    if (process.platform !== "win32") {
      helperState = "unavailable";
      publish();
      return;
    }
    helperState = "starting";
    error = null;
    const handle = win.getNativeWindowHandle();
    const pointer =
      handle.length >= 8
        ? handle.readBigUInt64LE(0).toString()
        : String(handle.readUInt32LE(0));
    helper = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Mta",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(__dirname, "windows/console.ps1"),
        "-DashboardHandle",
        pointer,
        "-NovaPid",
        String(process.pid),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
    const own = helper;
    reader = createInterface({ input: helper.stdout });
    reader.on("line", (line) => {
      if (own !== helper) return;
      try {
        receive(JSON.parse(line.replace(/^\uFEFF/, "")));
      } catch {}
    });
    helper.stderr.on("data", () => {});
    helper.stdin.on("error", () => {});
    helper.on("error", () => {
      if (own === helper)
        receive({
          type: "error",
          message:
            "Az automatikus visszatérés nem indult el. A Ctrl+Alt+N gyorsbillentyűvel visszahívhatod a NOVA-t.",
        });
    });
    helper.on("exit", () => {
      if (own === helper) {
        helper = null;
        clearTimeout(readyTimer);
        helperState = "error";
        settleReady(false);
        controller = { connected: false, nativeInput: false };
        onPad(controller);
        if (session) onSession(session, "error");
        if (enabled || session) {
          error =
            "A játékfigyelés megállt. A NOVA továbbra is a háttérben marad.";
          notice(error);
          publish();
        }
      }
    });
    readyTimer = setTimeout(() => {
      if (own === helper && helperState === "starting")
        receive({
          type: "error",
          message:
            "Az automatikus visszatérés előkészítése nem fejeződött be. A Ctrl+Alt+N billentyűvel visszahívhatod a NOVA-t.",
        });
    }, 20000);
  }
  function sync(previous) {
    const settings = getSettings(),
      next = !!settings.consoleMode,
      changed = next !== enabled;
    enabled = next;
    if (enabled) {
      win.setFullScreen(true);
      win.setMinimizable(false);
    } else {
      win.setMinimizable(true);
      if (
        previous?.consoleMode ||
        (previous && previous.fullscreen !== settings.fullscreen)
      )
        win.setFullScreen(!!settings.fullscreen);
    }
    syncHotkey();
    if (changed && !enabled) {
      minimizedForGame = null;
      error = null;
    }
    if (helperState === "off") start();
    config();
    if (!shouldWatch() && session) {
      onSession(session, "disabled");
      session = null;
      try {
        write("clear");
      } catch {}
    }
    publish();
  }
  async function ready() {
    if (helperState === "ready") return true;
    if (helperState !== "starting") return false;
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        readyWaiters.delete(finish);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 21000);
      readyWaiters.add(finish);
    });
  }
  async function targetFor(game) {
    if (
      game.type === "windows" ||
      (game.type === "file" && /\.exe$/i.test(game.target))
    )
      return policy.trackingFor(game);
    let resolved;
    try {
      const result = await run(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(__dirname, "windows/tracking-target.ps1"),
          "-Mode",
          game.type,
          "-Target",
          game.target,
        ],
        { windowsHide: true, timeout: 10000, maxBuffer: 65536 },
      );
      resolved = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
    } catch {}
    return policy.trackingFor(game, resolved);
  }
  function shouldWatch() {
    const settings = getSettings();
    return (
      enabled || settings.minimizeOnLaunch || settings.playtimeTracking !== false
    );
  }
  async function prepare(game) {
    if (!shouldWatch()) return null;
    if (session?.gameId === game.id && session.phase === "starting")
      throw Error("A játék indítása már folyamatban van.");
    const [available, target] = await Promise.all([ready(), targetFor(game)]);
    if (!shouldWatch()) return null;
    if (session) onSession(session, "switched");
    session = policy.newSession(game);
    minimizedForGame = null;
    trackedTarget = target;
    trackedPid = null;
    if (!available) {
      session.phase = "untracked";
      publish();
      return session.id;
    }
    const id = session.id;
    publish();
    const watching = new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        watchWaiters.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 3000);
      watchWaiters.set(id, finish);
    });
    try {
      write(policy.watchCommand(id, target));
    } catch {
      watchWaiters.get(id)?.(false);
    }
    if (!(await watching) && session?.id === id) {
      session.phase = "untracked";
      publish();
    }
    return id;
  }
  function attached(id, pid) {
    if (id && session?.id === id && Number.isSafeInteger(pid) && pid > 0) {
      trackedPid = pid;
      try {
        write("attach|" + id + "|" + pid);
      } catch {}
    }
  }
  function launchFailed(id) {
    if (id && session?.id === id) {
      onSession(session, "failed");
      minimizedForGame = null;
      session = null;
      try {
        write("clear");
      } catch {}
      publish();
    }
  }
  function afterLaunch(id) {
    if (id && session?.id !== id) return;
    if (policy.launchAction(getSettings()) === "backdrop") {
      if (win.isMinimized()) win.restore();
      win.setFullScreen(true);
      win.blur();
    } else if (getSettings().minimizeOnLaunch && !win.isMinimized()) {
      minimizedForGame = id ?? null;
      win.minimize();
    }
  }
  async function resume() {
    if (helperState !== "ready" || !session?.canResume)
      throw Error(
        "A játékablak nem érhető el. Az Alt+Tab billentyűkkel válthatsz vissza.",
      );
    const request = ++resumeSequence;
    const result = new Promise((resolve) => {
      const finish = (ok) => {
        clearTimeout(timer);
        resumeWaiters.delete(request);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 2500);
      resumeWaiters.set(request, finish);
    });
    try {
      write("resume|" + request);
    } catch {
      resumeWaiters.get(request)?.(false);
    }
    if (!(await result))
      throw Error(
        "Nem sikerült a játékablakra váltani. A játék futhat tovább a háttérben.",
      );
    return true;
  }
  async function closeGame(id) {
    if (
      helperState !== "ready" ||
      !session ||
      session.id !== id ||
      session.phase !== "running" ||
      !session.canResume
    )
      throw Error("A játékablak már nem zárható be innen.");
    const request = ++resumeSequence;
    const result = new Promise((resolve) => {
      const finish = (ok) => {
        clearTimeout(timer);
        closeWaiters.delete(request);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 2500);
      closeWaiters.set(request, finish);
    });
    try {
      write("close-game|" + request + "|" + id);
    } catch {
      closeWaiters.get(request)?.(false);
    }
    if (!(await result))
      throw Error(
        "Nem sikerült bezárási kérést küldeni a játékablaknak. Lépj ki a játék saját menüjéből.",
      );
    return true;
  }
  async function recover(stale = false) {
    if (disposed) return false;
    if (stale || helperState !== "ready") {
      stop();
      start();
      if (!(await ready())) return false;
      if (session && trackedTarget) {
        session = { ...session, phase: "starting", canResume: false };
        write(policy.watchCommand(session.id, trackedTarget));
      }
    }
    if (disposed) return false;
    config();
    write("suspend|" + (suspended ? "1" : "0"));
    if (!suspended) write("refresh");
    syncHotkey();
    publish();
    return true;
  }
  function recoverOnce(stale = false) {
    if (!recoveryTask)
      recoveryTask = recover(stale).finally(() => {
        recoveryTask = null;
      });
    return recoveryTask;
  }
  function resetDashboardInput() {
    try {
      write("dashboard-input");
    } catch {}
    if (win.isDestroyed()) return;
    win.webContents.send("nova:window-active", win.isFocused?.() ?? true);
    win.webContents.send("nova:recovered");
  }
  if (process.platform === "win32")
    try {
      tray = new Tray(
        nativeImage.createFromPath(path.join(__dirname, "../dist/icon.png")),
      );
      tray.on("double-click", requestHome);
    } catch {}
  sync();
  return {
    snapshot,
    sync,
    prepare,
    attached,
    launchFailed,
    afterLaunch,
    prepareMedia() {
      // Prepare the backdrop before the verified Edge focus transfer. Blurring
      // or minimising here lets Windows reactivate an unrelated window.
      if (enabled) {
        if (win.isMinimized()) win.restore();
        if (!win.isFullScreen()) win.setFullScreen(true);
      }
    },
    resume,
    closeGame,
    show: requestHome,
    showDashboard() {
      try {
        write("main");
      } catch {}
      show(false);
    },
    openGuide: requestGuide,
    setMediaActive(value) {
      mediaActive = !!value;
      syncHotkey();
      try {
        write("media-active|" + (mediaActive ? 1 : 0));
      } catch {}
      publish();
    },
    command: write,
    refreshConfig: config,
    recover: () => recoverOnce(),
    returnFromMedia() {
      show(false);
      if (win.isDestroyed()) return;
      win.webContents.focus?.();
      resetDashboardInput();
      clearTimeout(returnTimer);
      returnTimer = setTimeout(() => {
        if (
          disposed ||
          suspended ||
          mediaActive ||
          win.isDestroyed() ||
          !(win.isFocused?.() ?? true)
        )
          return;
        const stale =
          helperState === "ready" && performance.now() - lastHeartbeat > 2500;
        if (stale || helperState === "error")
          recoverOnce(stale)
            .then((ok) => {
              if (
                ok &&
                !mediaActive &&
                !suspended &&
                (win.isFocused?.() ?? true)
              )
                resetDashboardInput();
            })
            .catch(() => {});
      }, 3000);
      returnTimer.unref?.();
    },
    suspend(value) {
      suspended = !!value;
      if (helper)
        try {
          write("suspend|" + (value ? "1" : "0"));
        } catch {}
    },
    desktop,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(returnTimer);
      stop();
      if (registered) globalShortcut.unregister(HOTKEY);
      registered = false;
      if (tray && !tray.isDestroyed()) tray.destroy();
    },
  };
}
module.exports = { createConsoleMode };
