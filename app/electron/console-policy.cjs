const crypto = require("node:crypto");
function fullscreen(settings) {
  return !!(settings.consoleMode || settings.fullscreen);
}
function launchAction(settings) {
  return settings.consoleMode
    ? "backdrop"
    : settings.minimizeOnLaunch
      ? "minimize"
      : "keep";
}
function normalizeSettings(next, patch) {
  if (patch.consoleMode === true && patch.fullscreen === false)
    throw Error("A konzol mód teljes képernyős megjelenítést használ.");
  if (patch.fullscreen === false) next.consoleMode = false;
  return next;
}
function trackingFor(game, resolved) {
  if (game.type === "windows")
    return { kind: "windows", target: game.target, directory: "" };
  if (game.type === "file" && /\.exe$/i.test(game.target))
    return { kind: "exe", target: game.target, directory: "" };
  if (
    resolved &&
    ["exe", "steam", "unknown"].includes(resolved.kind) &&
    typeof resolved.target === "string" &&
    resolved.target.length < 2000 &&
    !resolved.target.includes("\0")
  ) {
    if (resolved.kind === "steam" && !/^\d{1,12}$/.test(resolved.target))
      throw Error("Érvénytelen Steam-játékazonosító.");
    return {
      kind: resolved.kind,
      target: resolved.target,
      directory:
        typeof resolved.directory === "string" &&
        resolved.directory.length < 2000
          ? resolved.directory
          : "",
    };
  }
  return game.type === "steam"
    ? { kind: "steam", target: game.target, directory: "" }
    : { kind: "unknown", target: "", directory: "" };
}
function watchCommand(id, target) {
  if (
    !/^[a-f0-9-]{36}$/i.test(id) ||
    !["exe", "steam", "windows", "unknown"].includes(target.kind)
  )
    throw Error("Érvénytelen játékkövetés.");
  return [
    "watch",
    id,
    target.kind,
    Buffer.from(target.target, "utf8").toString("base64"),
    Buffer.from(target.directory, "utf8").toString("base64"),
  ].join("|");
}
function newSession(game) {
  return {
    id: crypto.randomUUID(),
    gameId: game.id,
    name: game.name,
    phase: "starting",
    canResume: false,
  };
}
module.exports = {
  fullscreen,
  launchAction,
  normalizeSettings,
  trackingFor,
  watchCommand,
  newSession,
};
