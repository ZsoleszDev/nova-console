const path = require("node:path");
const { shouldShowClock } = require("./idle-policy.cjs");
function createIdleClock({
  BrowserWindow,
  screen,
  powerMonitor,
  getSettings,
  mediaOpen,
  onChange = () => {},
  now = () => performance.now(),
}) {
  let windows = [],
    locked = false,
    lastReset = now(),
    padIdleMs = 0,
    padHeartbeat = -Infinity,
    disposed = false,
    opening = 0;
  function hide() {
    opening++;
    const old = windows;
    windows = [];
    for (const w of old) if (!w.isDestroyed()) w.destroy();
    if (old.length) onChange(false);
  }
  function reset() {
    lastReset = now();
    hide();
  }
  async function show() {
    if (windows.length || disposed) return;
    const generation = ++opening;
    const created = screen.getAllDisplays().map((display) => {
      const w = new BrowserWindow({
        ...display.bounds,
        show: false,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        backgroundColor: "#0b0b0b",
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      w.setIgnoreMouseEvents(true);
      w.setAlwaysOnTop(true, "screen-saver");
      w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      w.webContents.on("will-navigate", (e) => e.preventDefault());
      return w;
    });
    windows = created;
    try {
      await Promise.all(
        created.map((w) => w.loadFile(path.join(__dirname, "idle-clock.html"))),
      );
      if (generation !== opening || disposed) return;
      for (const w of created) if (!w.isDestroyed()) w.showInactive();
      onChange(true);
    } catch {
      if (generation === opening) reset();
    }
  }
  function tick() {
    if (disposed) return;
    let systemIdleMs;
    try {
      systemIdleMs = powerMonitor.getSystemIdleTime() * 1000;
    } catch {
      hide();
      return;
    }
    const s = getSettings();
    if (
      shouldShowClock({
        enabled: s.idleClock !== false,
        locked,
        mediaOpen: mediaOpen(),
        now: now(),
        lastReset,
        systemIdleMs,
        padIdleMs,
        padHeartbeat,
        timeoutMs: (s.idleMinutes || 5) * 60000,
      })
    )
      show();
    else hide();
  }
  const timer = setInterval(tick, 250);
  timer.unref?.();
  const changed = () => reset();
  screen.on("display-added", changed);
  screen.on("display-removed", changed);
  screen.on("display-metrics-changed", changed);
  return {
    reset,
    tick,
    padIdle(ms) {
      if (Number.isFinite(ms) && ms >= 0) {
        padIdleMs = ms;
        padHeartbeat = now();
        if (ms < 1000) hide();
      }
    },
    suspend(value) {
      locked = value;
      reset();
    },
    get visible() {
      return windows.length > 0;
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      hide();
      for (const event of [
        "display-added",
        "display-removed",
        "display-metrics-changed",
      ])
        screen.removeListener(event, changed);
    },
  };
}
module.exports = { createIdleClock };
