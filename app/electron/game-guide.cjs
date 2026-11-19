const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
function createGameGuide({
  mainWindow,
  getConsole,
  getSettings,
  getPlaytime,
  getGame,
  command,
  resume,
  closeGame,
  sleep,
  showMain,
  desktop,
}) {
  let window,
    loading,
    epoch = 0,
    closing = false;
  let audio = { available: false },
    error = null;
  function snapshot() {
    const console = getConsole(),
      game = getGame(console.session?.gameId);
    return {
      visible: !!window?.isVisible(),
      epoch,
      console,
      playtime: getPlaytime(),
      audio,
      error,
      profile: getSettings().name,
      accent: getSettings().accent,
      game: game
        ? {
            name: game.name,
            artwork: game.artwork,
            playtimeMs: game.playtimeMs,
          }
        : null,
    };
  }
  function publish() {
    if (window && !window.isDestroyed())
      window.webContents.send("nova:guide", snapshot());
  }
  function hide() {
    epoch++;
    if (window && !window.isDestroyed()) window.hide();
    try {
      command("guide-hide");
    } catch {}
  }
  function pointer() {
    const b = window.getNativeWindowHandle();
    return b.length >= 8
      ? b.readBigUInt64LE().toString()
      : String(b.readUInt32LE());
  }
  async function show(bounds) {
    const session = getConsole().session;
    if (!getSettings().consoleMode || !session) return;
    const token = ++epoch;
    error = null;
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({
        width: 520,
        height: 850,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: "#1a1a1a",
        title: "NOVA játékpanel",
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
      window.setMenu(null);
      window.setAlwaysOnTop(true, "screen-saver");
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (e) => e.preventDefault());
      window.on("close", (e) => {
        if (!closing) {
          e.preventDefault();
          hide();
        }
      });
      window.on("blur", () => {
        setTimeout(() => {
          if (
            window &&
            !window.isDestroyed() &&
            window.isVisible() &&
            !window.isFocused()
          )
            hide();
        }, 120);
      });
      loading = window.loadFile(path.join(__dirname, "../dist/index.html"), {
        query: { surface: "guide" },
      });
    }
    await loading;
    if (
      token !== epoch ||
      !getSettings().consoleMode ||
      getConsole().session?.id !== session.id
    )
      return;
    let rect =
      bounds &&
      [bounds.x, bounds.y, bounds.width, bounds.height].every(
        Number.isFinite,
      ) &&
      bounds.width > 0 &&
      bounds.height > 0
        ? bounds
        : mainWindow.getBounds();
    if (bounds && screen.screenToDipRect)
      rect = screen.screenToDipRect(null, rect);
    const display = screen.getDisplayMatching(rect),
      area = display.bounds;
    const margin = Math.min(24, Math.floor(area.width * 0.02));
    window.setBounds({
      x: area.x + margin,
      y: area.y + margin,
      width: Math.min(520, area.width - margin * 2),
      height: Math.min(900, area.height - margin * 2),
    });
    window.show();
    window.focus();
    window.webContents.focus();
    command(`guide-window|${pointer()}|${token}`);
    publish();
  }
  function register(name, fn) {
    ipcMain.handle("nova:" + name, async (event, ...args) => {
      const allowed =
        event.sender === mainWindow.webContents ||
        (window &&
          !window.isDestroyed() &&
          event.sender === window.webContents);
      if (!allowed) return { ok: false, error: "Tiltott játékpanelhívás." };
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        error = e.message;
        publish();
        return { ok: false, error: e.message };
      }
    });
  }
  register("getGuideState", snapshot);
  register("guideCommand", async (action, value) => {
    if (
      ![
        "resume",
        "home",
        "library",
        "settings",
        "desktop",
        "volume",
        "mute",
        "close-game",
        "sleep",
      ].includes(action)
    )
      throw Error("Ismeretlen játékpanelművelet.");
    if (action === "close-game") {
      if (
        value?.confirmed !== true ||
        typeof value.sessionId !== "string" ||
        !value.sessionId ||
        value.sessionId !== getConsole().session?.id
      )
        throw Error(
          "A játék megváltozott. Nyisd meg újra a bezárás megerősítését.",
        );
      await closeGame(value.sessionId);
      hide();
      showMain("home");
    } else if (action === "sleep") {
      hide();
      showMain("home");
      await sleep();
    } else if (action === "resume") {
      await resume();
      hide();
    } else if (["home", "library", "settings"].includes(action)) {
      hide();
      showMain(action === "home" ? "home" : action);
    } else if (action === "desktop") {
      hide();
      await desktop();
    } else {
      if (!audio.available) throw Error("A hangkimenet nem érhető el.");
      if (action === "volume") {
        if (!Number.isInteger(value) || value < 0 || value > 100)
          throw Error("A hangerő 0 és 100 között lehet.");
        command("audio|set|" + value);
      } else {
        if (typeof value !== "boolean") throw Error("Érvénytelen némítás.");
        command("audio|mute|" + (value ? 1 : 0));
      }
    }
    return true;
  });
  return {
    show,
    hide,
    publish,
    snapshot,
    input(message) {
      if (
        window &&
        !window.isDestroyed() &&
        window.isVisible() &&
        message.epoch === epoch
      )
        window.webContents.send("nova:controller-input", message);
    },
    pad(pad) {
      if (window && !window.isDestroyed() && window.isVisible())
        window.webContents.send("nova:controller-state", pad);
    },
    audio(next) {
      audio =
        next.available === true && Number.isFinite(next.volume)
          ? {
              available: true,
              volume: Math.max(0, Math.min(100, next.volume)),
              muted: next.muted === true,
            }
          : { available: false };
      publish();
    },
    dispose() {
      closing = true;
      hide();
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}
module.exports = { createGameGuide };
