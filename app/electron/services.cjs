// Ollama and Jarvis control for the NOVA mode picker (Windows only).
// Jarvis is asked to stop through its own local API first, so it can unload
// every model from the GPU; a forced stop is only the fallback.
const fsDefault = require("node:fs");
const pathDefault = require("node:path");
const httpDefault = require("node:http");

const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_APP = "ollama app.exe";
const OLLAMA_PROCESSES = ["ollama.exe", "ollama_llama_server.exe"];
const STARTUP_ITEMS = { ollama: "Ollama.lnk", jarvis: "Jarvis.lnk" };
const JARVIS_WINDOW_SCRIPT = pathDefault.join(
  __dirname,
  "windows/close-jarvis-window.ps1",
);
const JARVIS_LINK_SCRIPT =
  "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
  "$l=(New-Object -ComObject WScript.Shell).CreateShortcut($env:NOVA_LINK);" +
  "[Console]::Out.Write($l.Arguments)";
const JARVIS_PROCESS_SCRIPT =
  "$ErrorActionPreference='Stop';$d=$env:NOVA_JARVIS_DIR.TrimEnd('\\')+'\\jarvis.py';" +
  "@(Get-CimInstance Win32_Process -Filter 'Name=''pythonw.exe'' OR Name=''python.exe''' | " +
  "Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | " +
  "ForEach-Object { $_.ProcessId }) -join ','";

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function createServices({
  platform = process.platform,
  env = process.env,
  fs = fsDefault,
  path = pathDefault.win32,
  http = httpDefault,
  run,
  spawn,
  backupDir,
  ollamaUrl = OLLAMA_URL,
  alive = processAlive,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const windows = platform === "win32";
  const local = env.LOCALAPPDATA || "";
  const roaming = env.APPDATA || "";
  const home = env.USERPROFILE || "";

  function requireWindows() {
    if (!windows)
      throw Error("Az Ollama és a Jarvis kezelése a Windowsos NOVA-ban érhető el.");
  }

  function request(method, url, { headers = {}, body, timeout = 2500 } = {}) {
    return new Promise((resolve) => {
      let target;
      try {
        target = new URL(url);
      } catch {
        resolve({ ok: false, status: 0 });
        return;
      }
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          method,
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          agent: false,
          timeout,
          headers: {
            Host: target.host,
            ...(data
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": data.length,
                }
              : {}),
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
            }),
          );
          res.on("error", () => resolve({ ok: false, status: 0 }));
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve({ ok: false, status: 0 }));
      if (data) req.write(data);
      req.end();
    });
  }

  async function waitFor(check, timeoutMs, stepMs = 500, signal) {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) return null;
      if (await check()) return true;
      if (now() >= deadline) return false;
      await sleep(stepMs);
    }
  }

  async function processes() {
    if (!windows) return new Set();
    try {
      const { stdout } = await run("tasklist.exe", ["/FO", "CSV", "/NH"], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const names = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^"([^"]+)"/.exec(line.trim());
        if (match) names.add(match[1].toLowerCase());
      }
      return names;
    } catch {
      return null;
    }
  }

  async function taskkill(args) {
    try {
      await run("taskkill.exe", ["/F", "/T", ...args], {
        windowsHide: true,
        timeout: 15000,
      });
      return true;
    } catch {
      // 128: nothing matched. Any other failure is caught by the caller's check.
      return false;
    }
  }

  // ---- Ollama -------------------------------------------------------------

  async function ollamaUp() {
    return (await request("GET", ollamaUrl + "/api/version", { timeout: 1500 }))
      .ok;
  }

  async function ollamaRunning() {
    const names = await processes();
    if (names === null) return ollamaUp();
    return [OLLAMA_APP, ...OLLAMA_PROCESSES].some((n) => names.has(n));
  }

  function ollamaExecutable() {
    const dirs = [
      path.join(local, "Programs", "Ollama"),
      path.join(env.ProgramFiles || "C:\\Program Files", "Ollama"),
    ];
    for (const dir of dirs) {
      const app = path.join(dir, OLLAMA_APP);
      if (local && fs.existsSync(app)) return { file: app, args: [] };
    }
    for (const dir of dirs) {
      const server = path.join(dir, "ollama.exe");
      if (local && fs.existsSync(server)) return { file: server, args: ["serve"] };
    }
    return { file: "ollama.exe", args: ["serve"] };
  }

  function launch(file, args, cwd) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(file, args, {
          cwd,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        });
      } catch (e) {
        reject(e);
        return;
      }
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve(child.pid);
      });
    });
  }

  async function startOllama({ timeoutMs = 60000, signal } = {}) {
    requireWindows();
    if (await ollamaUp()) return { started: false };
    const exe = ollamaExecutable();
    try {
      await launch(exe.file, exe.args, path.dirname(exe.file) || undefined);
    } catch {
      throw Error(
        "Az Ollama nem található. Telepítsd az ollama.com oldalról, vagy indítsd el kézzel.",
      );
    }
    const up = await waitFor(ollamaUp, timeoutMs, 750, signal);
    if (up === false)
      throw Error("Az Ollama elindult, de egy percen belül nem válaszolt.");
    return { started: true };
  }

  async function stopOllama({ timeoutMs = 8000 } = {}) {
    requireWindows();
    if (!(await ollamaRunning())) return { stopped: false };
    // The tray app restarts its server, so it goes first.
    await taskkill(["/IM", OLLAMA_APP]);
    await taskkill(OLLAMA_PROCESSES.flatMap((name) => ["/IM", name]));
    const gone = await waitFor(async () => !(await ollamaRunning()), timeoutMs);
    if (!gone)
      throw Error(
        "Az Ollama nem állt le. Zárd be a tálcaikonjából (Quit Ollama), majd válassz újra.",
      );
    return { stopped: true };
  }

  // ---- Jarvis -------------------------------------------------------------

  function jarvisDataDir() {
    if (env.JARVIS_DATA_DIR) return env.JARVIS_DATA_DIR;
    return local ? path.join(local, "Jarvis") : "";
  }

  function jarvisInfo() {
    const dir = jarvisDataDir();
    if (!dir) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "fut.json"), "utf8"));
      if (
        !raw ||
        typeof raw.url !== "string" ||
        !/^http:\/\/127\.0\.0\.1:\d{1,5}\//.test(raw.url)
      )
        return null;
      const url = new URL(raw.url);
      return {
        base: url.origin,
        token: url.searchParams.get("t") || "",
        pid: Number.isSafeInteger(raw.pid) && raw.pid > 0 ? raw.pid : 0,
        standby: raw.standby === true,
      };
    } catch {
      return null;
    }
  }

  async function jarvisReachable(info = jarvisInfo()) {
    if (!info || !info.token) return false;
    return (
      await request(
        "GET",
        info.base + "/api/ping?t=" + encodeURIComponent(info.token),
        { timeout: 1500 },
      )
    ).ok;
  }

  function validJarvisDir(dir) {
    return (
      typeof dir === "string" &&
      dir.length > 0 &&
      dir.length < 1000 &&
      path.isAbsolute(dir) &&
      fs.existsSync(path.join(dir, "jarvis.py"))
    );
  }

  async function startupLinkTarget() {
    const link = path.join(startupDir(), STARTUP_ITEMS.jarvis);
    const candidates = [link];
    if (backupDir) candidates.push(path.join(backupDir, STARTUP_ITEMS.jarvis));
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const { stdout } = await run(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", JARVIS_LINK_SCRIPT],
          {
            windowsHide: true,
            timeout: 15000,
            env: { ...env, NOVA_LINK: file },
          },
        );
        const match = /"([^"]+?)\\jarvis\.py"/i.exec(String(stdout));
        if (match && validJarvisDir(match[1])) return match[1];
      } catch {}
    }
    return "";
  }

  async function findJarvis(configured) {
    if (validJarvisDir(configured)) return configured;
    if (!windows) return "";
    const fromLink = await startupLinkTarget();
    if (fromLink) return fromLink;
    const roots = [
      home,
      home && path.join(home, "Desktop"),
      home && path.join(home, "Documents"),
      home && path.join(home, "Documents", "GitHub"),
      home && path.join(home, "source", "repos"),
      home && path.join(home, "Downloads"),
      "C:\\",
      "D:\\",
    ].filter(Boolean);
    for (const root of roots)
      for (const name of ["jarvis", "Jarvis", "jarvis-main"]) {
        const dir = path.join(root, name);
        if (validJarvisDir(dir)) return dir;
      }
    return "";
  }

  async function jarvisPids(dir) {
    if (!validJarvisDir(dir)) return [];
    const names = await processes();
    if (names && !names.has("pythonw.exe") && !names.has("python.exe")) return [];
    try {
      const { stdout } = await run(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", JARVIS_PROCESS_SCRIPT],
        {
          windowsHide: true,
          timeout: 20000,
          env: { ...env, NOVA_JARVIS_DIR: dir },
        },
      );
      return String(stdout)
        .trim()
        .split(",")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  async function jarvisStatus() {
    const info = jarvisInfo();
    if (!info) return "stopped";
    if (!(await jarvisReachable(info)))
      return alive(info.pid) ? "starting" : "stopped";
    return info.standby ? "standby" : "running";
  }

  async function closeJarvisWindows() {
    try {
      await run(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          JARVIS_WINDOW_SCRIPT,
        ],
        { windowsHide: true, timeout: 15000 },
      );
    } catch {}
  }

  async function stopJarvis({ dir = "", timeoutMs = 12000 } = {}) {
    requireWindows();
    const info = jarvisInfo();
    let wasRunning = false,
      forced = false;
    if (info && (await jarvisReachable(info))) {
      wasRunning = true;
      // /api/shutdown also unloads every model Ollama holds in VRAM.
      await request("POST", info.base + "/api/shutdown", {
        headers: { "X-Jarvis-Token": info.token },
        body: {},
        timeout: 4000,
      });
      const exited = await waitFor(
        async () => !alive(info.pid) && !(await jarvisReachable(info)),
        timeoutMs,
      );
      if (!exited && alive(info.pid)) {
        forced = true;
        await taskkill(["/PID", String(info.pid)]);
      }
    } else if (info && alive(info.pid)) {
      wasRunning = forced = true;
      await taskkill(["/PID", String(info.pid)]);
    }
    for (const pid of await jarvisPids(dir)) {
      wasRunning = forced = true;
      await taskkill(["/PID", String(pid)]);
    }
    if (wasRunning) await closeJarvisWindows();
    const pids = await jarvisPids(dir);
    if (pids.length || (info && alive(info.pid) && (await jarvisReachable(info))))
      throw Error(
        "A Jarvis nem állt le. Állítsd le a Jarvis ablakában (Leállítás), majd válassz újra.",
      );
    return { stopped: wasRunning, forced };
  }

  async function startJarvis({ dir, window = true, timeoutMs = 90000, signal } = {}) {
    requireWindows();
    if (!validJarvisDir(dir))
      throw Error(
        "Nincs beállítva a Jarvis mappája. Nyomd meg az Y gombot (Beállítások), és válaszd ki a jarvis.py mappáját.",
      );
    const scripts = path.join(dir, ".venv", "Scripts");
    const python = ["pythonw.exe", "python.exe"]
      .map((name) => path.join(scripts, name))
      .find((file) => fs.existsSync(file));
    if (!python)
      throw Error(
        "A Jarvis .venv környezete nem található. Telepítsd a Jarvis README-je szerint, majd próbáld újra.",
      );
    const status = await jarvisStatus();
    const args = [path.join(dir, "jarvis.py")];
    if (status === "running" || status === "standby") {
      // A second start only opens the window of the running Jarvis.
      if (window) await launch(python, args, dir).catch(() => {});
      return { started: false, status };
    }
    if (!window) args.push("--no-window");
    await launch(python, args, dir);
    const up = await waitFor(() => jarvisReachable(), timeoutMs, 1000, signal);
    if (up === false)
      throw Error(
        "A Jarvis elindult, de nem válaszol. A naplója: %LOCALAPPDATA%\\Jarvis\\naplo.txt",
      );
    return { started: true, status: "running" };
  }

  // ---- Windows Startup folder ---------------------------------------------

  function startupDir() {
    return path.join(
      roaming,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
    );
  }

  function startupSnapshot() {
    if (!windows || !roaming) return { ollama: false, jarvis: false, saved: [] };
    const result = { saved: [] };
    for (const [key, name] of Object.entries(STARTUP_ITEMS)) {
      result[key] = fs.existsSync(path.join(startupDir(), name));
      if (backupDir && fs.existsSync(path.join(backupDir, name)))
        result.saved.push(key);
    }
    return result;
  }

  function startupTakeover() {
    requireWindows();
    if (!backupDir) throw Error("Nincs mentési mappa.");
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of Object.values(STARTUP_ITEMS)) {
      const source = path.join(startupDir(), name);
      if (!fs.existsSync(source)) continue;
      const target = path.join(backupDir, name);
      fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
    }
    return startupSnapshot();
  }

  function startupRestore() {
    requireWindows();
    if (!backupDir) throw Error("Nincs mentési mappa.");
    for (const name of Object.values(STARTUP_ITEMS)) {
      const saved = path.join(backupDir, name);
      const target = path.join(startupDir(), name);
      if (!fs.existsSync(saved) || fs.existsSync(target)) continue;
      fs.renameSync(saved, target);
    }
    return startupSnapshot();
  }

  async function status() {
    if (!windows) return { ollama: null, jarvis: null };
    const [ollama, jarvis] = await Promise.all([ollamaRunning(), jarvisStatus()]);
    return { ollama, jarvis };
  }

  return {
    available: windows,
    status,
    ollamaUp,
    ollamaRunning,
    startOllama,
    stopOllama,
    jarvisInfo,
    jarvisStatus,
    findJarvis,
    validJarvisDir,
    startJarvis,
    stopJarvis,
    startupSnapshot,
    startupTakeover,
    startupRestore,
  };
}

module.exports = { createServices, OLLAMA_URL, STARTUP_ITEMS };
