const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { services } = require("./media-policy.cjs");
const validFile = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}\.(jpg|png)$/.test(value);
function cleanTileImages(input) {
  const result = {};
  if (!input || typeof input !== "object") return result;
  for (const [key, images] of Object.entries(input)) {
    if (
      !/^(game|media|cinema):[\w-]{1,100}$/.test(key) ||
      !images ||
      typeof images !== "object"
    )
      continue;
    const clean = {};
    for (const slot of ["cover", "background"])
      if (validFile(images[slot])) clean[slot] = images[slot];
    if (Object.keys(clean).length) result[key] = clean;
  }
  return result;
}
function createArtwork({
  app,
  protocol,
  nativeImage,
  dialog,
  getWindow,
  getState,
  persist,
  isCustomTarget = () => false,
}) {
  const directory = path.join(app.getPath("userData"), "artwork");
  async function set(target, slot, reset = false) {
    if (
      typeof target !== "string" ||
      !["cover", "background"].includes(slot) ||
      typeof reset !== "boolean"
    )
      throw Error("Érvénytelen képválasztás.");
    const state = getState(),
      game =
        target.startsWith("game:") &&
        state.games.find((g) => "game:" + g.id === target);
    if (
      !game &&
      !isCustomTarget(target) &&
      !(target.startsWith("media:") && Object.hasOwn(services, target.slice(6)))
    )
      throw Error("Az alkalmazás nem található.");
    state.tileImages ||= {};
    const previous = state.tileImages[target]?.[slot];
    let filename;
    if (!reset) {
      const selected = await dialog.showOpenDialog(getWindow(), {
        title:
          slot === "cover" ? "Borítókép választása" : "Háttérkép választása",
        properties: ["openFile"],
        filters: [
          { name: "Képek", extensions: ["jpg", "jpeg", "png", "webp"] },
        ],
      });
      if (selected.canceled) return null;
      const file = selected.filePaths[0];
      if ((await fs.stat(file)).size > 20 * 1024 * 1024)
        throw Error("Legfeljebb 20 MB-os képet válassz.");
      let image = nativeImage.createFromPath(file);
      if (image.isEmpty()) throw Error("A képet nem sikerült megnyitni.");
      const size = image.getSize();
      const scale = Math.min(
        1,
        (slot === "cover" ? 1200 : 3840) / size.width,
        (slot === "cover" ? 1200 : 2160) / size.height,
      );
      if (scale < 1)
        image = image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: "best",
        });
      // Preserve logo transparency on covers; backdrops keep their landscape ratio.
      filename = randomUUID() + (slot === "cover" ? ".png" : ".jpg");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, filename),
        slot === "cover" ? image.toPNG() : image.toJPEG(92),
      );
    }
    const oldImages = state.tileImages[target];
    const oldLegacy = game && game.artwork;
    state.tileImages[target] = { ...oldImages };
    if (filename) state.tileImages[target][slot] = filename;
    else delete state.tileImages[target][slot];
    if (game && slot === "cover") delete game.artwork;
    try {
      persist();
    } catch (e) {
      if (oldImages) state.tileImages[target] = oldImages;
      else delete state.tileImages[target];
      if (game && oldLegacy) game.artwork = oldLegacy;
      if (filename)
        await fs.unlink(path.join(directory, filename)).catch(() => {});
      throw e;
    }
    if (validFile(previous))
      await fs.unlink(path.join(directory, previous)).catch(() => {});
    return state.tileImages[target];
  }
  async function serve(request) {
    const url = new URL(request.url),
      filename = url.pathname.slice(1);
    if (
      url.hostname !== "local" ||
      !validFile(filename) ||
      !["GET", "HEAD"].includes(request.method)
    )
      return new Response(null, { status: 404 });
    try {
      const bytes = await fs.readFile(path.join(directory, filename));
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: {
          "content-type": filename.endsWith(".png")
            ? "image/png"
            : "image/jpeg",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  protocol?.handle("nova-art", serve);
  return { set, serve };
}
module.exports = { createArtwork, cleanTileImages };
