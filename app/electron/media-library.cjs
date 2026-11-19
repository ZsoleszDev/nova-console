const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { checkedPath, formats } = require("./local-files.cjs");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const kinds = ["mixed", "movies", "series"];
const defaultLabels = { movies: "Filmek", series: "Sorozatok" };
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep)
  );
};
const natural = new Intl.Collator("hu", { numeric: true, sensitivity: "base" });
const title = (name) =>
  name
    .replace(/\.[^.]+$/, "")
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
function describe(file, root) {
  const relative = path.relative(root.path, file),
    parts = relative.split(path.sep),
    name = path.basename(file);
  if (root.kind !== "series")
    return {
      titleId: hash((root.kind === "movies" ? "movie:" : "file:") + file),
      title: title(name),
      season: 0,
      episode: 0,
    };
  const match = name.match(
    /(?:s(\d{1,3})[ ._-]*e(\d{1,4})|(\d{1,3})x(\d{1,4}))/i,
  );
  const folderSeason = parts
    .slice(0, -1)
    .join(" ")
    .match(/(?:season|évad|evad)[ ._-]*(\d+)|(\d+)[ ._-]*(?:évad|evad)/i);
  let show =
    parts.length > 1
      ? parts[0]
      : match
        ? name.slice(0, match.index).replace(/[ ._-]+$/, "")
        : path.basename(root.path);
  if (/^(season|évad|evad)[ ._-]*\d+|^\d+[ ._-]*(évad|evad)$/i.test(show))
    show = path.basename(root.path);
  show = show.replace(/[._]/g, " ").trim() || path.basename(root.path);
  return {
    titleId: hash("series:" + root.id + ":" + show.toLocaleLowerCase("hu")),
    title: show,
    season: Number(
      match?.[1] || match?.[3] || folderSeason?.[1] || folderSeason?.[2] || 1,
    ),
    episode: Number(match?.[2] || match?.[4] || 0),
  };
}
function createMediaLibrary({ app, localFiles, dialog, getWindow }) {
  const file = path.join(app.getPath("userData"), "media-library.json");
  let state = { roots: [], entries: [], scannedAt: null, warnings: [] },
    running = false,
    queue = Promise.resolve();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(raw.roots) && Array.isArray(raw.entries))
      state = {
        ...state,
        ...raw,
        roots: raw.roots.filter(
          (r) =>
            r &&
            typeof r.path === "string" &&
            path.isAbsolute(r.path) &&
            kinds.includes(r.kind),
        ),
        entries: raw.entries.filter(
          (e) =>
            e &&
            typeof e.path === "string" &&
            /^[a-f0-9]{64}$/.test(e.id) &&
            typeof e.title === "string",
        ),
      };
  } catch {}
  function persist() {
    const text = JSON.stringify(state);
    queue = queue
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file + ".tmp", text);
        await fsp.rename(file + ".tmp", file);
      });
    return queue;
  }
  function snapshot() {
    return {
      ...state,
      roots: state.roots.map((r) => ({
        ...r,
        name:
          r.name || defaultLabels[r.kind] || path.basename(r.path) || r.path,
      })),
      entries: state.entries.map(({ path: _, ...e }) => ({
        ...e,
        format: e.format || "video",
      })),
      scanning: running,
    };
  }
  async function scan(roots = state.roots, catalogRoots = state.roots) {
    if (running) throw Error("A médiatár frissítése már folyamatban van.");
    running = true;
    const scanning = new Set(roots.map((root) => root.id));
    const previous = new Map();
    for (const entry of state.entries) {
      if (!previous.has(entry.rootId)) previous.set(entry.rootId, new Map());
      previous.get(entry.rootId).set(entry.path, entry);
    }
    const entries = state.entries.filter(
      (entry) => !scanning.has(entry.rootId),
    );
    const warnings = [];
    try {
      for (const root of roots) {
        const oldEntries = previous.get(root.id) || new Map();
        let visited = 0;
        const found = [];
        let unavailable = false;
        async function walk(dir, depth) {
          if (depth > 10) {
            warnings.push("Túl mély mappaszerkezet: " + path.basename(dir));
            return;
          }
          let children;
          try {
            const real = await fsp.realpath(dir);
            if (path.relative(dir, real) || !inside(root.path, real))
              throw Error("Mappa átirányítva.");
            children = await fsp.readdir(real, { withFileTypes: true });
          } catch {
            warnings.push("Nem érhető el: " + dir);
            if (dir === root.path) unavailable = true;
            else
              for (const old of oldEntries.values())
                if (inside(dir, old.path))
                  found.push({ ...old, available: false });
            return;
          }
          for (const child of children.sort((a, b) =>
            natural.compare(a.name, b.name),
          )) {
            if (++visited > 30000)
              throw Error(
                "Túl nagy médiatár. Válassz szűkebb mappát (legfeljebb 30 000 bejegyzés).",
              );
            if (child.name.startsWith(".") || child.isSymbolicLink()) continue;
            const full = path.join(dir, child.name);
            const format = formats[path.extname(full).toLowerCase()]?.[0];
            if (child.isDirectory()) await walk(full, depth + 1);
            else if (
              child.isFile() &&
              format &&
              (root.kind === "mixed" || format === "video")
            ) {
              let stat;
              try {
                stat = await fsp.lstat(full);
                if (!stat.isFile()) continue;
              } catch {
                continue;
              }
              const old = oldEntries.get(full);
              const same =
                old?.size === stat.size && old?.mtime === stat.mtimeMs;
              const details = describe(full, root);
              found.push({
                id: old?.id || hash(root.id + "\0" + full),
                rootId: root.id,
                path: full,
                name: child.name,
                ...details,
                titleId:
                  old?.titleId ||
                  (root.kind === "series"
                    ? details.titleId
                    : hash(root.id + "\0" + details.titleId)),
                kind: root.kind,
                format,
                folder: path.relative(root.path, path.dirname(full)),
                at: same ? old.at || 0 : 0,
                size: stat.size,
                mtime: stat.mtimeMs,
                available: true,
                watched: same ? !!old.watched : false,
                position: same ? old.position || 0 : 0,
                duration: same ? old.duration || 0 : 0,
              });
            }
          }
        }
        await walk(root.path, 0);
        if (unavailable && !state.roots.some((entry) => entry.id === root.id))
          throw Error("A mappa a beolvasás közben elérhetetlenné vált.");
        entries.push(
          ...(unavailable
            ? [...oldEntries.values()].map((e) => ({ ...e, available: false }))
            : found),
        );
      }
      const old = state;
      state = {
        ...state,
        roots: catalogRoots,
        entries,
        warnings: warnings.slice(0, 20),
        scannedAt: Date.now(),
      };
      try {
        await persist();
      } catch (e) {
        state = old;
        throw e;
      }
      return { ...snapshot(), scanning: false };
    } finally {
      running = false;
    }
  }
  function orderedAfter(item) {
    return state.entries
      .filter((e) => e.titleId === item.titleId)
      .sort(
        (a, b) =>
          a.season - b.season ||
          a.episode - b.episode ||
          natural.compare(a.name, b.name),
      );
  }
  function nextOf(item) {
    const mixedVideo = item.kind === "mixed" && item.format === "video";
    if (item.kind !== "series" && !mixedVideo) return null;
    const ordered = mixedVideo
      ? state.entries
          .filter(
            (e) =>
              e.rootId === item.rootId &&
              e.folder === item.folder &&
              e.format === "video",
          )
          .sort((a, b) => natural.compare(a.name, b.name))
      : orderedAfter(item);
    return ordered[ordered.findIndex((e) => e.id === item.id) + 1] || null;
  }
  async function checkPath(rootId, file) {
    const root = state.roots.find((r) => r.id === rootId);
    if (!root || !inside(root.path, file)) return false;
    const real = await fsp.realpath(file);
    return (
      inside(root.path, real) &&
      !path.relative(file, real) &&
      state.roots.some((r) => r === root)
    );
  }
  async function prepareEntry(id, fromStart = false) {
    const item = state.entries.find((e) => e.id === id);
    if (!item) throw Error("A fájl már nincs a médiatárban.");
    let stat;
    try {
      if (!(await checkPath(item.rootId, item.path)))
        throw Error("Nem elérhető.");
      stat = await fsp.lstat(item.path);
    } catch {
      throw Error(
        "A fájl nem érhető el. Csatlakoztasd a meghajtót, majd frissítsd a médiatárat.",
      );
    }
    if (
      !stat.isFile() ||
      stat.size !== item.size ||
      stat.mtimeMs !== item.mtime
    )
      throw Error("A fájl megváltozott. Frissítsd a médiatárat.");
    const media = await localFiles.prepare(item.path, {
      authorize: (file) => checkPath(item.rootId, file),
    });
    const next = nextOf(item);
    return {
      ...media,
      resume: fromStart
        ? 0
        : item.position || (item.duration || item.at ? 0 : media.resume),
      libraryId: id,
      nextVideo: next ? { name: next.name } : null,
    };
  }
  return {
    snapshot,
    async next(id) {
      const item = state.entries.find((e) => e.id === id);
      const next = item && nextOf(item);
      if (!next) throw Error("Nincs következő rész.");
      return prepareEntry(next.id, true);
    },
    listContinue() {
      return [...state.entries]
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .flatMap((item) => {
          if (!item.available) return [];
          const next = item.watched && !item.position && nextOf(item);
          if (!(item.position > 0 && item.duration > 0) && !next?.available)
            return [];
          return [
            {
              id: item.id,
              name: next ? next.name : item.name,
              position: item.position,
              duration: item.duration,
              next: Boolean(next),
            },
          ];
        })
        .slice(0, 8);
    },
    resume(id) {
      const item = state.entries.find((e) => e.id === id);
      const next = item?.watched && !item.position && nextOf(item);
      return next ? prepareEntry(next.id, true) : prepareEntry(id);
    },
    hasTitle: (id) => state.entries.some((e) => e.titleId === id),
    async addRoot(kind, name = "", folderPath = "") {
      if (
        !kinds.includes(kind) ||
        typeof name !== "string" ||
        name.trim().length > 80 ||
        /[\x00-\x1f]/.test(name)
      )
        throw Error(
          "Adj meg érvényes mappatípust és legfeljebb 80 karakteres nevet.",
        );
      if (running) throw Error("Várd meg a frissítést.");
      if (typeof folderPath !== "string")
        throw Error("Érvénytelen mappaútvonal.");
      let input = folderPath.trim();
      if (!input) {
        const pick = await dialog.showOpenDialog(getWindow(), {
          title: "Mappa kiválasztása a Médiatárhoz",
          buttonLabel: "Hozzáadás",
          properties: ["openDirectory"],
        });
        if (pick.canceled || !pick.filePaths?.[0]) return snapshot();
        input = pick.filePaths[0];
      }
      let selected;
      try {
        selected = await fsp.realpath(checkedPath(input));
        if (!(await fsp.stat(selected)).isDirectory())
          throw Error("Nem mappa.");
        await fsp.access(selected, fs.constants.R_OK);
        // Confirm the root can be enumerated before recording it as added.
        const directory = await fsp.opendir(selected);
        await directory.close();
      } catch {
        throw Error(
          "A mappa nem nyitható meg. Ellenőrizd az elérési utat, a hozzáférést és hogy a meghajtó csatlakozik-e.",
        );
      }
      if (running) throw Error("Várd meg a frissítést.");
      const duplicate = state.roots.find(
        (r) => !path.relative(r.path, selected),
      );
      if (duplicate)
        throw Error(
          "Ez a mappa már szerepel a Médiatárban: " +
            (duplicate.name || path.basename(selected)),
        );
      const root = {
        id: randomUUID(),
        path: selected,
        kind,
        name: name.trim() || path.basename(selected) || selected,
      };
      return scan([root], [...state.roots, root]);
    },
    scan: () => scan(),
    async removeRoot(id) {
      if (running) throw Error("Várd meg a frissítést.");
      const old = state;
      state = {
        ...state,
        roots: state.roots.filter((r) => r.id !== id),
        entries: state.entries.filter((e) => e.rootId !== id),
      };
      try {
        await persist();
      } catch (e) {
        state = old;
        throw e;
      }
      return snapshot();
    },
    async setWatched(id, watched) {
      if (typeof watched !== "boolean") throw Error("Érvénytelen jelölés.");
      const item = state.entries.find((e) => e.id === id);
      if (!item) throw Error("A fájl már nincs a médiatárban.");
      const old = { ...item };
      Object.assign(item, { watched, position: 0, at: Date.now() });
      try {
        await persist();
      } catch (e) {
        Object.assign(item, old);
        throw e;
      }
      return snapshot();
    },
    prepare: prepareEntry,
    async progress(file, data) {
      const items = state.entries.filter((e) => !path.relative(e.path, file));
      if (!items.length || !data.duration) return;
      const done =
        data.position >= data.duration - Math.min(10, data.duration * 0.03);
      for (const item of items)
        Object.assign(item, {
          position: done ? 0 : Math.min(data.position, data.duration),
          at: Date.now(),
          duration: data.duration,
          watched: item.watched || done,
        });
      await persist();
    },
  };
}
module.exports = { createMediaLibrary, describe };
