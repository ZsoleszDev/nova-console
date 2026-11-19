const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const formats = {
  ".mp4": ["video", "video/mp4"],
  ".m4v": ["video", "video/mp4"],
  ".webm": ["video", "video/webm"],
  ".ogv": ["video", "video/ogg"],
  ".mov": ["video", "video/quicktime"],
  ".mkv": ["video", "video/x-matroska"],
  ".avi": ["video", "video/x-msvideo"],
  ".wmv": ["video", "video/x-ms-wmv"],
  ".mpg": ["video", "video/mpeg"],
  ".mpeg": ["video", "video/mpeg"],
  ".mp3": ["audio", "audio/mpeg"],
  ".m4a": ["audio", "audio/mp4"],
  ".aac": ["audio", "audio/aac"],
  ".ogg": ["audio", "audio/ogg"],
  ".opus": ["audio", "audio/ogg"],
  ".wav": ["audio", "audio/wav"],
  ".flac": ["audio", "audio/flac"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".png": ["image", "image/png"],
  ".webp": ["image", "image/webp"],
  ".gif": ["image", "image/gif"],
  ".bmp": ["image", "image/bmp"],
};
function checkedPath(value, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path;
  if (
    typeof value !== "string" ||
    value.length > 32760 ||
    value.includes("\0") ||
    !p.isAbsolute(value) ||
    /^\\\\[?.]\\/.test(value)
  )
    throw Error("Érvénytelen mappa vagy fájl.");
  return p.normalize(value);
}
function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, status: 200 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])),
    end = m[1] ? (m[2] ? Number(m[2]) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  return { start, end: Math.min(end, size - 1), status: 206 };
}
const collator = new Intl.Collator("hu", {
  numeric: true,
  sensitivity: "base",
});
function decodeSubtitle(bytes) {
  let text;
  if (bytes[0] === 255 && bytes[1] === 254)
    text = new TextDecoder("utf-16le").decode(bytes);
  else
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("windows-1250").decode(bytes);
    }
  text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT\b/.test(text)) return text;
  if (!/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text))
    throw Error("A felirat nem érvényes SRT vagy WebVTT.");
  return "WEBVTT\n\n" + text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}
function createLocalFiles({
  app,
  protocol,
  onProgress = async () => {},
  platform = process.platform,
  runCommand = run,
}) {
  const tokens = new Map(),
    streams = new Set();
  const progressFile = path.join(app.getPath("userData"), "local-media.json");
  let saved = {},
    persistQueue = Promise.resolve();
  try {
    if (fs.statSync(progressFile).size < 1024 * 1024)
      saved = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  } catch {}
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  async function locations() {
    const shortcuts = [
      ["home", "Saját mappa"],
      ["videos", "Videók"],
      ["downloads", "Letöltések"],
      ["music", "Zene"],
      ["pictures", "Képek"],
    ]
      .map(([id, name]) => {
        try {
          return { id, name, path: app.getPath(id), type: "folder" };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    let drives = [],
      warning = null;
    if (platform === "win32")
      try {
        const r = await runCommand(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            // Per-process only, matching NOVA's other Windows helpers. Without
            // this, default Restricted policy rejects -File and hides drives.
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(__dirname, "windows/list-drives.ps1"),
          ],
          { windowsHide: true, timeout: 10000, maxBuffer: 65536 },
        );
        const parsed = JSON.parse(r.stdout.replace(/^\uFEFF/, ""));
        drives = (Array.isArray(parsed) ? parsed : [parsed])
          .filter(
            (d) =>
              d && typeof d.path === "string" && /^[a-z]:\\$/i.test(d.path),
          )
          .map((d) => ({
            id: d.path,
            name:
              d.path +
              " · " +
              (d.kind === "Network"
                ? "Hálózati meghajtó"
                : d.kind === "Removable"
                  ? "Cserélhető meghajtó"
                  : "Meghajtó"),
            path: d.path,
            type: "drive",
          }));
        // Empty or malformed helper output is a failed enumeration, not a
        // claim that the system drive is the only installed drive.
        if (!drives.length) throw Error("No logical drives returned");
      } catch {
        warning =
          "Nem sikerült lekérni az összes meghajtót; a lista hiányos lehet. Próbáld a Meghajtók frissítése gombot. A saját mappáidat addig is megnyithatod.";
      }
    else
      drives = [{ id: "root", name: "Számítógép", path: "/", type: "drive" }];
    if (!drives.length && shortcuts.length) {
      const root = path.win32.parse(shortcuts[0].path).root;
      if (root) drives = [{ id: root, name: root, path: root, type: "drive" }];
    }
    return { locations: [...drives, ...shortcuts], warning };
  }
  async function browse(request = {}) {
    const directory = checkedPath(request.path, platform),
      filter = ["all", "video", "audio", "image"].includes(request.filter)
        ? request.filter
        : "all";
    let rows;
    try {
      rows = await fsp.readdir(directory, { withFileTypes: true });
    } catch (e) {
      throw Error(
        e.code === "EACCES" || e.code === "EPERM"
          ? "Ehhez a mappához nincs hozzáférésed."
          : e.code === "ENOENT"
            ? "Ez a mappa nem található."
            : "A mappa nem olvasható. Ellenőrizd, hogy a meghajtó elérhető-e.",
      );
    }
    const query =
      typeof request.query === "string"
        ? request.query.slice(0, 200).toLocaleLowerCase("hu")
        : "";
    const entries = rows
      .filter(
        (e) =>
          !e.name.startsWith(".") &&
          !["$RECYCLE.BIN", "System Volume Information"].includes(e.name),
      )
      .map((e) => {
        const ext = path.extname(e.name).toLowerCase(),
          kind = e.isDirectory()
            ? "folder"
            : formats[ext]?.[0] || (e.isSymbolicLink() ? "folder" : "file");
        return {
          name: e.name,
          path: path.join(directory, e.name),
          kind,
          extension: ext,
          link: e.isSymbolicLink(),
        };
      })
      .filter(
        (e) =>
          (e.kind === "folder" || filter === "all" || e.kind === filter) &&
          (!query || e.name.toLocaleLowerCase("hu").includes(query)),
      )
      .sort(
        (a, b) =>
          (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) ||
          collator.compare(a.name, b.name),
      );
    const offset = Number.isSafeInteger(request.offset)
        ? Math.max(0, request.offset)
        : 0,
      parent = path.dirname(directory);
    return {
      path: directory,
      parent: parent === directory ? null : parent,
      entries: entries.slice(offset, offset + 200),
      total: entries.length,
      offset,
      nextOffset: offset + 200 < entries.length ? offset + 200 : null,
    };
  }
  async function nextVideo(input) {
    const entries = await fsp.readdir(path.dirname(input), {
      withFileTypes: true,
    });
    const videos = entries
      .filter(
        (e) =>
          !e.name.startsWith(".") &&
          (e.isFile() || e.isSymbolicLink()) &&
          formats[path.extname(e.name).toLowerCase()]?.[0] === "video",
      )
      .map((e) => e.name)
      .sort(collator.compare);
    const index = videos.indexOf(path.basename(input));
    return index >= 0 && videos[index + 1]
      ? path.join(path.dirname(input), videos[index + 1])
      : null;
  }
  async function prepare(value, { authorize } = {}) {
    const input = checkedPath(value, platform),
      format = formats[path.extname(input).toLowerCase()];
    if (!format)
      throw Error("A beépített nézegető videót, zenét és képet nyit meg.");
    if (authorize && !(await authorize(input)))
      throw Error("A fájl kívül esik a hozzáadott médiamappákon.");
    const real = await fsp.realpath(input),
      stat = await fsp.stat(real);
    if (authorize && (!(await authorize(real)) || path.relative(input, real)))
      throw Error("A fájl útvonala megváltozott.");
    if (!stat.isFile() || stat.size === 0)
      throw Error("A fájl nem olvasható vagy üres.");
    const token = randomUUID(),
      key = createHash("sha256")
        .update(real + "\0" + stat.size + "\0" + stat.mtimeMs)
        .digest("hex");
    const record = {
      path: real,
      mime: format[1],
      kind: format[0],
      size: stat.size,
      key,
      subtitles: [],
      authorize,
      input,
      next: null,
    };
    if (record.kind === "video") {
      try {
        if (!authorize) record.next = await nextVideo(input);
      } catch {}
      const base = path
        .basename(real, path.extname(real))
        .toLocaleLowerCase("hu");
      try {
        const all = await fsp.readdir(path.dirname(real), {
          withFileTypes: true,
        });
        record.subtitles = all
          .filter(
            (e) =>
              e.isFile() &&
              [".srt", ".vtt"].includes(path.extname(e.name).toLowerCase()),
          )
          .sort(
            (a, b) =>
              Number(!a.name.toLocaleLowerCase("hu").startsWith(base)) -
                Number(!b.name.toLocaleLowerCase("hu").startsWith(base)) ||
              collator.compare(a.name, b.name),
          )
          .slice(0, 100)
          .map((e) => ({
            id: randomUUID(),
            name: e.name,
            path: path.join(path.dirname(real), e.name),
          }));
      } catch {}
    }
    tokens.set(token, record);
    return {
      token,
      url: "nova-media://local/" + token,
      name: path.basename(real),
      kind: record.kind,
      nextVideo: record.next ? { name: path.basename(record.next) } : null,
      size: stat.size,
      resume: Number.isFinite(saved[key]?.position) ? saved[key].position : 0,
      volume: Number.isFinite(saved.volume)
        ? Math.max(0, Math.min(1, saved.volume))
        : 0.8,
      subtitles: record.subtitles.map(({ id, name }) => ({ id, name })),
    };
  }
  async function subtitle(token, id) {
    const record = tokens.get(token);
    const file = record?.subtitles.find((s) => s.id === id);
    if (!file || (record.authorize && !(await record.authorize(file.path))))
      throw Error("A felirat nem érhető el.");
    const stat = await fsp.stat(file.path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw Error("A felirat legfeljebb 2 MB lehet.");
    return decodeSubtitle(await fsp.readFile(file.path));
  }
  async function progress(token, data) {
    const file = tokens.get(token);
    if (!file) return false;
    if (
      !data ||
      ![data.position, data.duration, data.volume].every(Number.isFinite) ||
      data.position < 0 ||
      data.duration < 0 ||
      data.duration > 7 * 86400 ||
      data.volume < 0 ||
      data.volume > 1
    )
      throw Error("Érvénytelen lejátszási állapot.");
    saved[file.key] = {
      position:
        data.duration > 0 &&
        data.position >= data.duration - Math.min(10, data.duration * 0.03)
          ? 0
          : Math.min(data.position, data.duration),
      at: Date.now(),
      path: file.input,
      name: path.basename(file.path),
      kind: file.kind,
      duration: data.duration,
      completed:
        data.duration > 0 &&
        data.position >= data.duration - Math.min(10, data.duration * 0.03),
      next: file.kind === "video" ? file.next : null,
    };
    saved.volume = data.volume;
    const recent = Object.entries(saved)
      .filter(
        ([key, value]) =>
          key !== "volume" && value && typeof value === "object",
      )
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, 50);
    saved = Object.fromEntries([["volume", saved.volume], ...recent]);
    const text = JSON.stringify(saved);
    persistQueue = persistQueue
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(path.dirname(progressFile), { recursive: true });
        await fsp.writeFile(progressFile + ".tmp", text, "utf8");
        await fsp.rename(progressFile + ".tmp", progressFile);
      });
    await persistQueue;
    await onProgress(file.input, data);
    return true;
  }
  async function serve(request) {
    try {
      const url = new URL(request.url);
      if (
        url.hostname !== "local" ||
        (request.method !== "GET" && request.method !== "HEAD")
      )
        return new Response(null, { status: 404 });
      const file = tokens.get(url.pathname.slice(1));
      if (!file || (file.authorize && !(await file.authorize(file.path))))
        return new Response(null, { status: 404 });
      const stat = await fsp.stat(file.path);
      if (!stat.isFile() || stat.size <= 0)
        return new Response(null, { status: 404 });
      const range = byteRange(request.headers.get("range"), stat.size);
      if (!range)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": "bytes */" + stat.size },
        });
      const headers = {
        "Content-Type": file.mime,
        "Accept-Ranges": "bytes",
        "Content-Length": String(Math.max(0, range.end - range.start + 1)),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (range.status === 206)
        headers["Content-Range"] =
          `bytes ${range.start}-${range.end}/${stat.size}`;
      if (request.method === "HEAD")
        return new Response(null, { status: range.status, headers });
      const stream = fs.createReadStream(file.path, {
        start: range.start,
        end: range.end,
      });
      streams.add(stream);
      stream.on("close", () => streams.delete(stream));
      request.signal?.addEventListener("abort", () => stream.destroy(), {
        once: true,
      });
      return new Response(Readable.toWeb(stream), {
        status: range.status,
        headers,
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  protocol?.handle("nova-media", serve);
  return {
    hasOpenMedia: () => tokens.size > 0,
    locations,
    browse,
    prepare,
    listContinue() {
      return Object.entries(saved)
        .filter(
          ([id, item]) =>
            /^[a-f0-9]{64}$/.test(id) &&
            item &&
            typeof item.path === "string" &&
            ["video", "audio"].includes(item.kind) &&
            Number.isFinite(item.duration) &&
            item.duration > 0 &&
            ((item.position > 0 && !item.completed) ||
              (item.completed && typeof item.next === "string")),
        )
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 8)
        .map(([id, item]) => ({
          id,
          name: item.completed ? path.basename(item.next) : item.name,
          kind: item.kind,
          position: item.completed ? 0 : item.position,
          duration: item.duration,
          next: !!item.completed,
          at: item.at,
        }));
    },
    async prepareContinue(id) {
      const item =
        typeof id === "string" && /^[a-f0-9]{64}$/.test(id) ? saved[id] : null;
      if (
        !item ||
        typeof item.path !== "string" ||
        !["video", "audio"].includes(item.kind)
      )
        throw Error("Ez a folytatás már nem érhető el.");
      if (item.completed) {
        const next = await nextVideo(item.path);
        if (!next) throw Error("Nincs következő videó ebben a mappában.");
        return { ...(await prepare(next)), resume: 0 };
      }
      const media = await prepare(item.path);
      if (tokens.get(media.token)?.key !== id) {
        tokens.delete(media.token);
        throw Error("A fájl megváltozott. Nyisd meg újra a Fájlkezelőből.");
      }
      return media;
    },
    async prepareNext(token) {
      const record = tokens.get(token);
      if (!record || record.kind !== "video")
        throw Error("A videó már nincs megnyitva.");
      const next = await nextVideo(record.input);
      if (!next) throw Error("Nincs következő videó ebben a mappában.");
      const media = await prepare(next);
      return { ...media, resume: 0 };
    },
    subtitle,
    progress,
    serve,
    release(token) {
      tokens.delete(token);
    },
    dispose() {
      for (const stream of streams) stream.destroy();
      tokens.clear();
    },
  };
}
module.exports = {
  createLocalFiles,
  checkedPath,
  byteRange,
  decodeSubtitle,
  formats,
};
