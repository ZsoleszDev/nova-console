const { BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const {
  services,
  commands,
  serviceFor,
  browserArgs,
  browserCandidates,
  validateText,
  validatePad,
  protectedPlaybackFor,
  playbackPages,
} = require("./media-policy.cjs");

function createMediaIntegration({
  app,
  mainWindow,
  getSettings = () => ({}),
  backgroundMain = () => {},
  onControlActive = () => {},
  focusMain = () => {
    mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  },
}) {
  let hud,
    hudLoad,
    hudTimer,
    relayPrevious = 0,
    relayHeld = 0,
    relayLatched = false,
    relayMove = 0,
    relayLast = 0,
    overlay,
    helper,
    readers,
    readyTimer,
    closing = false,
    intentEpoch = 0,
    openQueue = Promise.resolve(),
    activationSequence = 0,
    activation = null,
    overlayLoad,
    overlaySession = 0,
    closeTask = null;
  let state = {
    active: false,
    shuttingDown: false,
    controlActive: false,
    helperReady: false,
    browserActive: false,
    bound: false,
    manual: false,
    uiaWarning: false,
    source: "xinput",
    lastInteraction: 0,
    ready: false,
    controller: false,
    service: null,
    name: "Médiaböngésző",
    view: "toolbar",
    password: false,
    error: null,
    activating: false,
    filmMode: false,
    navigationMode: "pointer",
    pointerSpeed: "normal",
    inputSource: "native",
    overlaySession: 0,
  };
  const snapshot = () => ({
    ...state,
    accent: getSettings().accent,
    version: app.getVersion(),
    services,
  });
  function publish() {
    for (const w of [mainWindow, overlay, hud])
      if (w && !w.isDestroyed()) w.webContents.send("nova:media", snapshot());
  }
  let lastControlNotice;
  function controlActive(value) {
    state.controlActive = value;
    const active = value && state.active;
    if (lastControlNotice !== active) {
      lastControlNotice = active;
      onControlActive(active);
    }
  }
  function closeHud() {
    clearTimeout(hudTimer);
    if (hud && !hud.isDestroyed()) hud.destroy();
    hud = null;
    hudLoad = null;
    try {
      write("hud|0");
    } catch {}
  }
  function configureKeyboard() {
    write("auto|" + (getSettings().osk !== false ? "1" : "0"));
  }
  async function showHud() {
    // A transparent native window still participates in desktop composition
    // when its HTML is invisible. Protected services must never create one.
    if (
      state.filmMode ||
      !state.active ||
      !state.controlActive ||
      !state.browserActive ||
      overlay?.isVisible()
    )
      return;
    const remaining = 4500 - (Date.now() - state.lastInteraction);
    if (remaining <= 0) {
      hud?.hide();
      return;
    }
    if (!hud || hud.isDestroyed()) {
      hud = new BrowserWindow({
        width: 1000,
        height: 54,
        show: false,
        frame: false,
        resizable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        transparent: true,
        hasShadow: false,
        title: "NOVA médiás súgó",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      hud.setMenu(null);
      hud.setAlwaysOnTop(true, "screen-saver");
      hud.setIgnoreMouseEvents(true);
      hud.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      hud.webContents.on("will-navigate", (e) => e.preventDefault());
      hudLoad = hud.loadFile(path.join(__dirname, "../dist/index.html"), {
        query: { surface: "media-hud" },
      });
    }
    const ownedHud = hud;
    await hudLoad;
    if (hud !== ownedHud) return;
    if (
      state.filmMode ||
      !hud ||
      hud.isDestroyed() ||
      !state.active ||
      !state.controlActive ||
      !state.browserActive ||
      overlay?.isVisible()
    )
      return;
    const raw = state.bounds;
    let bounds = raw;
    if (raw && screen.screenToDipRect)
      bounds = screen.screenToDipRect(null, raw);
    const display =
      bounds && screen.getDisplayMatching
        ? screen.getDisplayMatching(bounds)
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.bounds;
    hud.setBounds({
      x: area.x + 24,
      y: area.y + area.height - 70,
      width: Math.max(200, area.width - 48),
      height: 54,
    });
    if (!hud.isVisible()) hud.showInactive();
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      if (hud && !hud.isDestroyed()) hud.hide();
    }, remaining);
    try {
      write("hud|" + handleFor(hud));
    } catch {}
  }
  function notice(message) {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send("nova:media-notice", message);
  }
  function write(command) {
    if (!helper || helper.killed || !helper.stdin.writable)
      throw Error(
        "A médiavezérlő nem érhető el. Nyisd meg újra a médiakártyát.",
      );
    helper.stdin.write(command + "\n");
  }
  function cancelActivation() {
    if (!activation) return;
    clearTimeout(activation.timer);
    clearTimeout(activation.retry);
    activation.resolve(false);
    activation = null;
    state.activating = false;
  }
  async function activationFailed(pending, message) {
    if (activation !== pending) return;
    cancelActivation();
    state.error = message;
    publish();
    await show("toolbar");
  }
  function attemptActivation() {
    const pending = activation;
    if (!pending || pending.sent || !state.ready || !state.helperReady) return;
    pending.sent = true;
    // Hide the always-on-top panel before focusing Edge, never afterwards.
    hide();
    try {
      backgroundMain();
      write(
        `activate|${pending.id}|${pending.url ? "navigate|" + Buffer.from(pending.url, "utf8").toString("base64") : pending.action}`,
      );
    } catch (e) {
      activationFailed(pending, e.message).catch(() => {});
    }
  }
  function activateBrowser(url = null, action = "resume") {
    cancelActivation();
    state.activating = true;
    state.error = null;
    const pending = {
      id: ++activationSequence,
      url,
      action,
      sent: false,
      attempts: 0,
    };
    const result = new Promise((resolve) => {
      pending.resolve = resolve;
    });
    activation = pending;
    pending.timer = setTimeout(
      () =>
        activationFailed(
          pending,
          "Nem sikerült előtérbe hozni a médiaböngészőt. Válaszd a Folytatás gombot az újrapróbáláshoz, vagy térj vissza a NOVA-ba.",
        ).catch(() => {}),
      30000,
    );
    publish();
    attemptActivation();
    return result;
  }
  function position(view) {
    let browserBounds = state.bounds;
    if (browserBounds && screen.screenToDipRect)
      browserBounds = screen.screenToDipRect(null, browserBounds);
    const match =
      browserBounds?.width > 100 ? browserBounds : mainWindow.getBounds?.();
    const display =
      match && screen.getDisplayMatching
        ? screen.getDisplayMatching(match)
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = display.bounds;
    const width = Math.min(view === "keyboard" ? 1080 : 560, bounds.width - 36);
    const height = Math.min(
      view === "keyboard" ? 690 : 650,
      bounds.height - 36,
    );
    overlay.setBounds({
      x: Math.round(bounds.x + (bounds.width - width) / 2),
      y: Math.round(bounds.y + (bounds.height - height) / 2),
      width,
      height,
    });
  }
  function handleFor(window) {
    const buffer = window.getNativeWindowHandle();
    return buffer.length === 8
      ? buffer.readBigUInt64LE().toString()
      : String(buffer.readUInt32LE());
  }
  async function show(view, password = false) {
    if (!state.active) return;
    cancelActivation();
    const session = ++overlaySession;
    state.overlaySession = session;
    state.view = view;
    state.password = !!password;
    hud?.hide();
    if (!overlay || overlay.isDestroyed()) {
      overlay = new BrowserWindow({
        width: 1080,
        height: 585,
        show: false,
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        skipTaskbar: true,
        alwaysOnTop: !state.filmMode,
        backgroundColor: "#1e1e1e",
        title: "NOVA médiavezérlő",
        icon: path.join(__dirname, "../dist/icon.png"),
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      overlay.setMenu(null);
      overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      overlay.webContents.on("will-navigate", (e) => e.preventDefault());
      overlay.on("close", (e) => {
        if (!closing) {
          e.preventDefault();
          activateBrowser();
        }
      });
      overlayLoad = overlay.loadFile(
        path.join(__dirname, "../dist/index.html"),
        {
          query: { surface: "media" },
        },
      );
    }
    await overlayLoad;
    if (session !== overlaySession || !state.active || closing) return;
    if (state.filmMode) overlay.setAlwaysOnTop(false);
    else overlay.setAlwaysOnTop(true, "screen-saver");
    position(view);
    publish();
    overlay.show();
    overlay.focus();
    overlay.webContents.focus();
    write(`overlay|${handleFor(overlay)}|${session}|${view}`);
  }
  function hide() {
    state.overlaySession = ++overlaySession;
    if (helper) {
      try {
        write("overlay-hide");
      } catch {}
    }
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    hud?.hide();
    state.password = false;
    state.view = "toolbar";
    publish();
  }
  function home() {
    intentEpoch++;
    cancelActivation();
    hide();
    controlActive(false);
    state.browserActive = false;
    publish();
    if (!mainWindow.isDestroyed()) focusMain();
  }
  function finishClose(ok) {
    if (!closeTask) return;
    const pending = closeTask;
    closeTask = null;
    clearTimeout(pending.timer);
    state.shuttingDown = false;
    if (ok) {
      state.active = false;
      state.ready = false;
      state.bound = false;
      state.helperReady = false;
      state.browserActive = false;
      state.error = null;
      stopHelper();
    } else {
      state.error =
        "A médiaböngésző bezárását nem sikerült igazolni. Nyisd meg újra a médiamenüt, és próbáld újra a bezárást.";
      if (!closing) notice(state.error);
    }
    publish();
    pending.resolve(ok);
  }
  function closeAndHome() {
    if (closeTask) return closeTask.promise;
    home(); // Return immediately, even if the browser or helper is unresponsive.
    if (!state.active) return Promise.resolve(true);
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    closeTask = {
      promise,
      resolve,
      timer: setTimeout(() => finishClose(false), 9000),
    };
    state.shuttingDown = true;
    publish();
    try {
      write("close");
    } catch {
      finishClose(false);
    }
    return promise;
  }
  function endSession() {
    finishClose(false);
    const returnHome = state.controlActive || overlay?.isVisible();
    clearTimeout(readyTimer);
    intentEpoch++;
    cancelActivation();
    state.active = false;
    state.ready = false;
    state.helperReady = false;
    state.bound = false;
    state.browserActive = false;
    controlActive(false);
    hide();
    publish();
    if (returnHome && !closing && !mainWindow.isDestroyed()) focusMain();
  }
  function stopHelper() {
    cancelActivation();
    clearTimeout(readyTimer);
    if (readers) {
      readers.close();
      readers = null;
    }
    if (helper) {
      const old = helper;
      helper = null;
      try {
        old.stdin.write("stop\n");
        old.stdin.end();
      } catch {}
      const timer = setTimeout(() => {
        if (old.exitCode === null) old.kill();
      }, 1500);
      timer.unref();
    }
  }
  function receive(message) {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "browser-closed") {
      finishClose(message.ok === true);
      return;
    }
    if (
      closeTask &&
      [
        "ui",
        "toolbar",
        "keyboard",
        "keyboard-metadata",
        "activation",
        "error",
        "no-field",
      ].includes(message.type)
    )
      return;
    if (message.type === "ui") {
      state.lastInteraction = Date.now();
      const allowed = [
        "up",
        "down",
        "left",
        "right",
        "select",
        "back",
        "delete",
        "shift",
        "keyboard",
        "menu",
        "home",
      ];
      if (
        state.active &&
        overlay &&
        !overlay.isDestroyed() &&
        overlay.isVisible() &&
        message.session === state.overlaySession &&
        allowed.includes(message.action)
      )
        overlay.webContents.send("nova:media-input", {
          action: message.action,
          session: message.session,
        });
    } else if (message.type === "navigation") {
      if (
        ["pointer", "links", "arrows"].includes(message.mode) &&
        ["slow", "normal", "fast"].includes(message.speed)
      ) {
        state.navigationMode = message.mode;
        state.pointerSpeed = message.speed;
        publish();
      }
    } else if (message.type === "helper-ready") {
      state.helperReady = true;
      attemptActivation();
      publish();
    } else if (message.type === "status") {
      state.bound = message.bound === true;
      state.ready = state.bound;
      state.browserActive = message.browserActive === true;
      state.source = message.source === "relay" ? "relay" : "xinput";
      if (
        message.bounds &&
        [
          message.bounds.x,
          message.bounds.y,
          message.bounds.width,
          message.bounds.height,
        ].every(Number.isFinite)
      )
        state.bounds = message.bounds;
      if (message.inputActive) state.lastInteraction = Date.now();
      if (state.bound && overlay?.isVisible()) position(state.view);
      if (state.browserActive) {
        if (state.controlActive) showHud().catch(() => {});
      } else hud?.hide();
      if (state.bound) attemptActivation();
      publish();
    } else if (message.type === "activation") {
      const pending = activation;
      if (!pending || message.request !== pending.id || !pending.sent) return;
      if (message.ok === true) {
        clearTimeout(pending.timer);
        clearTimeout(pending.retry);
        activation = null;
        state.activating = false;
        state.browserActive = true;
        state.error = null;
        pending.resolve(true);
        // The acknowledged Edge window already owns the foreground. Hide
        // NOVA's backdrop, retaining its process and controller rescue route.
        if (state.filmMode && !mainWindow.isDestroyed()) mainWindow.hide();
        publish();
        showHud().catch(() => {});
      } else if (message.reason === "cancelled") {
        // The user switched to another application: do not steal focus back.
        cancelActivation();
        state.error =
          "Az ablakváltás megszakadt. A NOVA médiakártyájáról újrapróbálhatod.";
        publish();
      } else if (++pending.attempts < 8) {
        pending.retry = setTimeout(() => {
          if (activation !== pending) return;
          pending.sent = false;
          attemptActivation();
        }, 200);
      } else
        activationFailed(
          pending,
          "A Windows nem engedte előtérbe hozni a böngészőt. Próbáld a Folytatás gombot, vagy a View gombbal térj vissza a NOVA-ba.",
        ).catch(() => {});
    } else if (message.type === "keyboard-metadata") {
      if (state.view === "keyboard") {
        state.password = !!message.password;
        state.manual = false;
        publish();
      }
    } else if (message.type === "uia-warning") {
      state.uiaWarning = true;
      publish();
    } else if (message.type === "discovery-warning") {
      state.discoveryWarning = true;
      publish();
    } else if (message.type === "ready") {
      clearTimeout(readyTimer);
      state.ready = true;
      state.bound = true;
      state.helperReady = true;
      state.error = null;
      attemptActivation();
      publish();
    } else if (
      message.type === "connected" ||
      message.type === "disconnected"
    ) {
      state.controller = message.type === "connected";
      publish();
    } else if (message.type === "keyboard") {
      if (!state.active || !state.controlActive || state.activating) return;
      if (message.manual !== true && getSettings().osk === false) return;
      state.manual = message.manual === true;
      show("keyboard", message.password).catch(() =>
        notice("Nem sikerült megnyitni a billentyűzetet."),
      );
    } else if (message.type === "toolbar") {
      if (!state.active || !state.controlActive) return;
      show("toolbar").catch(() => {});
    } else if (message.type === "home") {
      closeAndHome();
    } else if (message.type === "typed") {
      state.error = null;
      publish();
    } else if (message.type === "no-field") {
      state.error =
        "Kattints előbb egy kereső- vagy szövegmezőre az A gombbal. Ezután nyomd meg az X-et.";
      if (state.controlActive) show("toolbar").catch(() => {});
    } else if (message.type === "error") {
      state.error =
        typeof message.message === "string"
          ? message.message
          : "A médiavezérlő hibát jelzett.";
      publish();
      if (state.controlActive) show("toolbar").catch(() => {});
      notice(state.error);
    } else if (message.type === "closed") {
      endSession();
    }
  }
  function register(name, fn, { mainOnly = false } = {}) {
    ipcMain.handle("nova:" + name, async (event, ...args) => {
      const allowed =
        event.sender === mainWindow.webContents ||
        (!mainOnly &&
          overlay &&
          !overlay.isDestroyed() &&
          event.sender === overlay.webContents) ||
        (name === "getMediaState" &&
          hud &&
          !hud.isDestroyed() &&
          event.sender === hud.webContents);
      if (!allowed) return { ok: false, error: "Tiltott médiavezérlő hívás." };
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return {
          ok: false,
          error: e.message || "A médiaművelet nem sikerült.",
        };
      }
    });
  }
  register("getMediaState", snapshot);
  function openMedia(key) {
    const epoch = intentEpoch;
    const task = openQueue.then(() => openMediaOnce(key, epoch));
    openQueue = task.catch(() => {});
    return task;
  }
  async function openMediaOnce(key, epoch) {
    if (closeTask && !(await closeTask.promise)) throw Error(state.error);
    if (closing || epoch !== intentEpoch) return snapshot();
    if (process.platform !== "win32")
      throw Error(
        "A kontrolleres médiaböngésző a Windowsos NOVA-ban érhető el.",
      );
    const service = serviceFor(key);
    const browser = browserCandidates(process.env).find((p) =>
      fs.existsSync(p),
    );
    if (!browser)
      throw Error(
        "Microsoft Edge nem található. Telepítsd vagy frissítsd az Edge-et, majd próbáld újra.",
      );
    if (state.active && helper && !helper.killed) {
      hide();
      state.service = key;
      state.name = service.name;
      state.filmMode = protectedPlaybackFor(key);
      if (state.filmMode) closeHud();
      configureKeyboard();
      state.error = null;
      controlActive(true);
      state.lastInteraction = Date.now();
      await show("toolbar");
      if (!closing && epoch === intentEpoch) activateBrowser(service.url);
      return snapshot();
    }
    stopHelper();
    const profile = path.join(app.getPath("userData"), "media-profile");
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(browser, browserArgs(profile, key), {
      windowsHide: false,
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    if (closing || epoch !== intentEpoch) return snapshot();
    state = {
      ...state,
      active: true,
      controlActive: true,
      ready: false,
      bound: false,
      browserActive: false,
      helperReady: false,
      manual: false,
      uiaWarning: false,
      service: key,
      name: service.name,
      filmMode: protectedPlaybackFor(key),
      controller: false,
      view: "toolbar",
      password: false,
      error: null,
      activating: false,
      bounds: null,
    };
    if (state.filmMode) closeHud();
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
        path.join(__dirname, "windows/controller.ps1"),
        "-BrowserPid",
        String(child.pid),
        "-BrowserProfile",
        profile,
        "-NovaPid",
        String(process.pid),
        "-DashboardHandle",
        handleFor(mainWindow),
        "-BrowserExe",
        browser,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
    const ownedHelper = helper;
    readers = createInterface({ input: helper.stdout });
    readers.on("line", (line) => {
      if (ownedHelper !== helper) return;
      try {
        receive(JSON.parse(line.replace(/^\uFEFF/, "")));
      } catch {}
    });
    // stderr is drained but not retained; field contents and input text are never logged.
    helper.stderr.on("data", () => {});
    helper.stdin.on("error", () => {});
    configureKeyboard();
    write("mode|" + state.navigationMode);
    write("speed|" + state.pointerSpeed);
    write(
      "config|" +
        (getSettings().controllerDeadzone ?? 35) +
        "|" +
        (getSettings().controllerRepeatMs ?? 160),
    );
    helper.on("error", () => {
      if (ownedHelper === helper) {
        state.error = "A Windowsos kontrollersegéd nem indult el.";
        state.ready = false;
        state.helperReady = false;
        cancelActivation();
        publish();
        notice(state.error);
      }
    });
    helper.on("exit", () => {
      if (ownedHelper === helper) {
        helper = null;
        endSession();
      }
    });
    readyTimer = setTimeout(() => {
      if (ownedHelper === helper && !state.ready) {
        state.error =
          "A kontrollersegéd indítása hosszabb ideig tart. Az Edge-et közben egérrel is használhatod.";
        publish();
      }
    }, 25000);
    relayPrevious = 0;
    relayHeld = 0;
    relayLatched = false;
    controlActive(true);
    state.lastInteraction = Date.now();
    await show("toolbar");
    if (!closing && epoch === intentEpoch) activateBrowser();
    return snapshot();
  }
  register("openMedia", openMedia, { mainOnly: true });
  register("mediaCommand", async (command) => {
    if (typeof command !== "string" || !commands.has(command))
      throw Error("Ismeretlen böngészőművelet.");
    if (command === "home" || command === "close") {
      closeAndHome();
      return snapshot();
    }
    if (state.shuttingDown)
      throw Error("A médiaböngésző bezárása folyamatban van.");
    if (command === "retry") {
      if (!state.service) throw Error("Előbb válassz szolgáltatást.");
      const key = state.service;
      stopHelper();
      state.ready = false;
      state.active = false;
      home();
      return openMedia(key);
    }
    if (!state.active) throw Error("Előbb nyiss meg egy médiaszolgáltatást.");
    if (command.startsWith("mode-") || command.startsWith("speed-")) {
      const [kind, value] = command.split("-");
      write(kind + "|" + value);
      if (kind === "mode") state.navigationMode = value;
      else state.pointerSpeed = value;
      publish();
      return snapshot();
    }
    if (command === "guide") {
      try {
        write("pause");
      } catch {}
      controlActive(true);
      await show("toolbar");
      return snapshot();
    }
    if (command === "keyboard" && !state.ready)
      throw Error("A kontrollersegéd még indul.");
    controlActive(true);
    if (command === "return-service")
      await activateBrowser(serviceFor(state.service).url);
    else if (Object.hasOwn(playbackPages, command))
      await activateBrowser(playbackPages[command]);
    else await activateBrowser(null, command);
    return snapshot();
  });
  register("sendMediaText", async (text, options) => {
    const command = validateText(text, options);
    if (!state.active || !state.ready || state.view !== "keyboard")
      throw Error("Nincs kiválasztott szövegmező.");
    try {
      hide();
      backgroundMain();
      write(command);
    } catch (e) {
      state.error = e.message;
      await show("toolbar");
      throw e;
    }
    return true;
  });
  register(
    "showMediaControls",
    async () => {
      if (state.shuttingDown)
        throw Error("A médiaböngésző bezárása folyamatban van.");
      if (!state.active) throw Error("A médiaböngésző nincs megnyitva.");
      try {
        write("pause");
      } catch {}
      controlActive(true);
      await show("toolbar");
      return snapshot();
    },
    { mainOnly: true },
  );
  register(
    "relayMediaPad",
    (sample) => {
      const line = validatePad(sample),
        now = Date.now();
      if (!state.active || !state.controlActive) return false;
      if (now - relayLast < 15) return false;
      relayLast = now;
      const pressed = sample.buttons & ~relayPrevious;
      if ((sample.buttons & 0x30) === 0x30) {
        if (!relayHeld) relayHeld = now;
        if (!relayLatched && now - relayHeld >= 1000) {
          relayLatched = true;
          try {
            write("home");
          } catch {}
          closeAndHome();
        }
      } else {
        relayHeld = 0;
        relayLatched = false;
      }
      if (
        pressed & 0x20 &&
        !(sample.buttons & 0x10) &&
        (state.browserActive || overlay?.isFocused?.())
      ) {
        try {
          write("home");
        } catch {}
        closeAndHome();
      }
      if (!state.helperReady && overlay?.isVisible()) {
        const action =
          sample.buttons & 1 || sample.ly > 18000
            ? "up"
            : sample.buttons & 2 || sample.ly < -18000
              ? "down"
              : sample.buttons & 4 || sample.lx < -18000
                ? "left"
                : sample.buttons & 8 || sample.lx > 18000
                  ? "right"
                  : null;
        const send = (action) =>
          overlay.webContents.send("nova:media-input", {
            action,
            session: state.overlaySession,
          });
        if (action && now - relayMove > 170) {
          send(action);
          relayMove = now;
        }
        for (const [mask, action] of [
          [0x1000, "select"],
          [0x2000, "back"],
          [0x10, "menu"],
          [0x4000, state.view === "keyboard" ? "delete" : "keyboard"],
          [0x8000, "shift"],
        ])
          if (pressed & mask) send(action);
      }
      relayPrevious = sample.buttons;
      if (helper)
        try {
          write(line);
        } catch {}
      return true;
    },
    { mainOnly: true },
  );
  return {
    snapshot,
    home: closeAndHome,
    suspend() {
      intentEpoch++;
      cancelActivation();
      controlActive(false);
      hide();
      if (helper)
        try {
          write("pause");
        } catch {}
    },
    settingsChanged() {
      if (helper)
        try {
          configureKeyboard();
          write(
            "config|" +
              (getSettings().controllerDeadzone ?? 35) +
              "|" +
              (getSettings().controllerRepeatMs ?? 160),
          );
        } catch {}
    },
    dispose() {
      closing = true;
      finishClose(false);
      intentEpoch++;
      stopHelper();
      closeHud();
      controlActive(false);
      if (overlay && !overlay.isDestroyed()) overlay.destroy();
      if (hud && !hud.isDestroyed()) hud.destroy();
    },
  };
}
module.exports = { createMediaIntegration };
