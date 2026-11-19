const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { cleanTileImages } = require("./artwork.cjs");
const defaults = {
  idleClock: true,
  idleMinutes: 5,
  bootAnimation: true,
  haptics: false,
  batteryAlerts: true,
  quietInGames: true,
  consoleMode: false,
  overlayEnabled: true,
  playtimeTracking: true,
  controllerDeadzone: 35,
  controllerRepeatMs: 160,
  osk: true,
  name: "Játékos",
  fullscreen: true,
  startup: false,
  minimizeOnLaunch: true,
  sounds: true,
  soundVolume: 20,
  animations: true,
  accent: "mono",
  largeText: false,
  wallpaper: "forza",
  modePicker: true,
  modePickerSetup: false,
  modeCountdown: 30,
  defaultMode: "jarvis",
  currentMode: "",
  jarvisPath: "",
  jarvisWindow: true,
  consoleGuard: true,
};
const modes = ["console", "jarvis", "windows"];
const modeCountdowns = [10, 15, 20, 30, 45, 60, 90, 120];
const allowedExtensions = new Set([".exe", ".lnk", ".url"]);
function validateGame(game) {
  if (
    !game ||
    typeof game.name !== "string" ||
    !game.name.trim() ||
    game.name.length > 120
  )
    throw Error("Adj meg egy 1–120 karakteres nevet.");
  if (game.type === "file") {
    if (
      typeof game.target !== "string" ||
      !path.win32.isAbsolute(game.target) ||
      !allowedExtensions.has(path.win32.extname(game.target).toLowerCase())
    )
      throw Error("Windows .exe, .lnk vagy .url fájl választható.");
  } else if (game.type === "steam") {
    if (!/^\d{1,12}$/.test(game.target))
      throw Error("Érvénytelen Steam-azonosító.");
  } else if (game.type === "windows") {
    if (
      typeof game.target !== "string" ||
      !/^[a-zA-Z0-9_.!\-{}]+$/.test(game.target) ||
      game.target.length > 250
    )
      throw Error("Érvénytelen alkalmazásazonosító.");
  } else throw Error("Ismeretlen indítási mód.");
  return {
    id: crypto.randomUUID(),
    name: game.name.trim(),
    type: game.type,
    target: game.target,
    favorite: false,
    addedAt: Date.now(),
    lastPlayed: null,
    launches: 0,
    playtimeMs: 0,
    lastSessionMs: 0,
    playSessions: 0,
  };
}
function parseSteamLibraryPaths(text) {
  return [...text.matchAll(/"path"\s+"([^"\r\n]+)"/g)].map((m) =>
    m[1].replace(/\\\\/g, "\\"),
  );
}
function parseSteamManifest(text) {
  const id = /"appid"\s+"(\d+)"/.exec(text)?.[1];
  const name = /"name"\s+"([^"\r\n]+)"/.exec(text)?.[1];
  const state = /"StateFlags"\s+"(\d+)"/.exec(text)?.[1];
  return id && name && Number(state) & 4
    ? { name, type: "steam", target: id }
    : null;
}
const safeCount = (n) =>
  Number.isFinite(n) ? Math.max(0, Math.min(1e12, Math.floor(n))) : 0;
function cleanSettings(input = {}) {
  const settings = { ...defaults };
  for (const [key, value] of Object.entries(defaults))
    if (typeof input[key] === typeof value) settings[key] = input[key];
  if (!settings.name.trim() || settings.name.length > 30)
    settings.name = defaults.name;
  settings.accent = defaults.accent;
  if (!["forza", "ori", "plain"].includes(settings.wallpaper))
    settings.wallpaper = defaults.wallpaper;
  if (!modeCountdowns.includes(settings.modeCountdown))
    settings.modeCountdown = defaults.modeCountdown;
  if (!modes.includes(settings.defaultMode))
    settings.defaultMode = defaults.defaultMode;
  if (settings.currentMode !== "" && !modes.includes(settings.currentMode))
    settings.currentMode = "";
  if (
    settings.jarvisPath.length > 1000 ||
    (settings.jarvisPath && !path.win32.isAbsolute(settings.jarvisPath))
  )
    settings.jarvisPath = "";
  for (const [key, min, max] of [
    ["controllerDeadzone", 20, 70],
    ["soundVolume", 0, 60],
    ["idleMinutes", 1, 60],
    ["controllerRepeatMs", 100, 300],
  ])
    if (
      !Number.isInteger(settings[key]) ||
      settings[key] < min ||
      settings[key] > max
    )
      settings[key] = defaults[key];
  return settings;
}
function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      settings: cleanSettings(raw.settings || {}),
      tileImages: cleanTileImages(raw.tileImages),
      games: Array.isArray(raw.games)
        ? raw.games
            .filter((g) => {
              try {
                validateGame(g);
                return typeof g.id === "string";
              } catch {
                return false;
              }
            })
            .map((g) => ({
              ...g,
              playtimeMs: safeCount(g.playtimeMs),
              lastSessionMs: safeCount(g.lastSessionMs),
              playSessions: safeCount(g.playSessions),
            }))
        : [],
      playSessions: Array.isArray(raw.playSessions)
        ? raw.playSessions
            .filter(
              (s) =>
                typeof s.sessionId === "string" &&
                typeof s.gameId === "string" &&
                Number.isFinite(s.durationMs) &&
                s.durationMs >= 0,
            )
            .slice(0, 200)
        : [],
      playtimeActive:
        raw.playtimeActive &&
        typeof raw.playtimeActive.sessionId === "string" &&
        typeof raw.playtimeActive.gameId === "string"
          ? {
              ...raw.playtimeActive,
              durationMs: safeCount(raw.playtimeActive.durationMs),
            }
          : null,
      history: Array.isArray(raw.history) ? raw.history.slice(0, 100) : [],
    };
  } catch {
    return {
      settings: { ...defaults },
      tileImages: {},
      games: [],
      history: [],
      playSessions: [],
      playtimeActive: null,
    };
  }
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(file + ".tmp", file);
}
module.exports = {
  defaults,
  modes,
  modeCountdowns,
  validateGame,
  parseSteamLibraryPaths,
  parseSteamManifest,
  loadState,
  saveState,
};
