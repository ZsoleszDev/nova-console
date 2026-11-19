// node --test tests/*.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServices } = require("../app/electron/services.cjs");

const LOCAL = "C:\\Users\\Teszt\\AppData\\Local";
const ROAMING = "C:\\Users\\Teszt\\AppData\\Roaming";
const STARTUP = ROAMING + "\\Microsoft\\Windows\\Start Menu\\Programs\\Startup";
const JARVIS = "C:\\Users\\Teszt\\jarvis";
const BACKUP = ROAMING + "\\NOVA\\startup-backup";

function fakeFs(files = {}) {
  const data = new Map(Object.entries(files));
  return {
    data,
    existsSync: (p) => data.has(p),
    readFileSync: (p) => {
      if (!data.has(p)) throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
      return data.get(p);
    },
    mkdirSync: () => {},
    rmSync: (p) => data.delete(p),
    renameSync: (a, b) => {
      data.set(b, data.get(a));
      data.delete(a);
    },
  };
}
function fakeRun(handlers = {}) {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, env: options?.env });
    const handler = handlers[file.toLowerCase()];
    if (!handler) return { stdout: "" };
    return handler(args, options);
  };
  return { run, calls };
}
function fakeSpawn() {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const listeners = {};
    const child = {
      pid: 4321,
      unref() {},
      once(event, cb) {
        listeners[event] = cb;
        if (event === "spawn") setImmediate(cb);
        return child;
      },
    };
    return child;
  };
  return { spawn, calls };
}
function services(overrides = {}) {
  return createServices({
    platform: "win32",
    env: { LOCALAPPDATA: LOCAL, APPDATA: ROAMING, USERPROFILE: "C:\\Users\\Teszt" },
    backupDir: BACKUP,
    sleep: () => new Promise((r) => setImmediate(r)),
    ollamaUrl: "http://127.0.0.1:9",
    ...overrides,
  });
}
function jarvisServer(onShutdown) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, token: req.headers["x-jarvis-token"], host: req.headers.host });
    if (req.url.startsWith("/api/ping?t=secret")) return res.end("{}");
    if (req.method === "POST" && req.url === "/api/shutdown" && req.headers["x-jarvis-token"] === "secret") {
      res.statusCode = 202;
      res.end("{}");
      onShutdown();
      return;
    }
    res.statusCode = 403;
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })),
  );
}

test("Jarvis stops through its own shutdown API, which also frees the GPU", async () => {
  let running = true;
  const { server, seen, port } = await jarvisServer(() => {
    running = false;
    setTimeout(() => server.close(), 5);
  });
  const fs = fakeFs({
    [LOCAL + "\\Jarvis\\fut.json"]: JSON.stringify({ url: `http://127.0.0.1:${port}/?t=secret`, pid: 777, standby: false }),
  });
  const runner = fakeRun();
  const s = services({ fs, run: runner.run, alive: () => running });
  const result = await s.stopJarvis({ dir: "", timeoutMs: 3000 });
  assert.deepEqual(result, { stopped: true, forced: false });
  const shutdown = seen.find((r) => r.url === "/api/shutdown");
  assert.equal(shutdown.token, "secret");
  assert.equal(shutdown.host, `127.0.0.1:${port}`);
  assert.ok(!runner.calls.some((c) => c.file === "taskkill.exe"), "no forced kill");
  assert.ok(runner.calls.some((c) => c.args.includes(require("node:path").join(__dirname, "../app/electron/windows/close-jarvis-window.ps1"))));
});

test("Jarvis that ignores the request is stopped with its whole process tree", async () => {
  const { server, port } = await jarvisServer(() => {});
  let alive = true;
  const fs = fakeFs({
    [LOCAL + "\\Jarvis\\fut.json"]: JSON.stringify({ url: `http://127.0.0.1:${port}/?t=secret`, pid: 777 }),
  });
  const runner = fakeRun({
    "taskkill.exe": (args) => {
      if (args.includes("777")) {
        alive = false;
        server.close();
      }
      return { stdout: "" };
    },
  });
  let clock = 0;
  const s = services({ fs, run: runner.run, alive: () => alive, now: () => (clock += 1000) });
  const result = await s.stopJarvis({ timeoutMs: 3000 });
  assert.deepEqual(result, { stopped: true, forced: true });
  const kill = runner.calls.find((c) => c.file === "taskkill.exe");
  assert.deepEqual(kill.args, ["/F", "/T", "/PID", "777"]);
});

test("stray Jarvis processes of the configured folder are found and stopped", async () => {
  const fs = fakeFs({ [JARVIS + "\\jarvis.py"]: "" });
  let listed = 0;
  const runner = fakeRun({
    "tasklist.exe": () => ({ stdout: '"pythonw.exe","1200","Console","1","90 K"' }),
    "powershell.exe": (args, options) => {
      if (options.env?.NOVA_JARVIS_DIR) return { stdout: listed++ === 0 ? "1200,1300" : "" };
      return { stdout: "0" };
    },
  });
  const s = services({ fs, run: runner.run, alive: () => false });
  const result = await s.stopJarvis({ dir: JARVIS });
  assert.deepEqual(result, { stopped: true, forced: true });
  const kills = runner.calls.filter((c) => c.file === "taskkill.exe").map((c) => c.args.at(-1));
  assert.deepEqual(kills, ["1200", "1300"]);
  assert.equal(runner.calls.find((c) => c.env?.NOVA_JARVIS_DIR).env.NOVA_JARVIS_DIR, JARVIS);
});

test("a stopped Jarvis is reported as not running", async () => {
  const runner = fakeRun();
  const s = services({ fs: fakeFs({ [JARVIS + "\\jarvis.py"]: "" }), run: runner.run, alive: () => false });
  assert.deepEqual(await s.stopJarvis({ dir: "" }), { stopped: false, forced: false });
  assert.equal(runner.calls.length, 0);
  // Without any Python process the slower process query is skipped.
  assert.deepEqual(await s.stopJarvis({ dir: JARVIS }), { stopped: false, forced: false });
  assert.deepEqual(runner.calls.map((c) => c.file), ["tasklist.exe", "tasklist.exe"]);
});

test("Ollama: tray app first, then server and runners", async () => {
  let names = ['"ollama app.exe","10","Console","1","20 K"', '"ollama.exe","11","Console","1","9 K"', '"explorer.exe","2","Console","1","1 K"'];
  const runner = fakeRun({
    "tasklist.exe": () => ({ stdout: names.join("\r\n") }),
    "taskkill.exe": (args) => {
      if (args.includes("ollama.exe")) names = names.filter((n) => !n.startsWith('"ollama'));
      return { stdout: "" };
    },
  });
  const s = services({ fs: fakeFs(), run: runner.run });
  assert.deepEqual(await s.stopOllama(), { stopped: true });
  const kills = runner.calls.filter((c) => c.file === "taskkill.exe").map((c) => c.args);
  assert.deepEqual(kills[0], ["/F", "/T", "/IM", "ollama app.exe"]);
  assert.deepEqual(kills[1], ["/F", "/T", "/IM", "ollama.exe", "/IM", "ollama_llama_server.exe"]);
  assert.deepEqual(await s.stopOllama(), { stopped: false });
});

test("Ollama that refuses to stop is reported", async () => {
  const runner = fakeRun({ "tasklist.exe": () => ({ stdout: '"ollama.exe","11","Console","1","9 K"' }) });
  let clock = 0;
  const s = services({ fs: fakeFs(), run: runner.run, now: () => (clock += 5000) });
  await assert.rejects(s.stopOllama(), /nem állt le/);
});

test("Ollama starts from its tray app and is awaited", async () => {
  const ollama = http.createServer((req, res) => res.end('{"version":"x"}'));
  await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
  const app = LOCAL + "\\Programs\\Ollama\\ollama app.exe";
  const spawner = fakeSpawn();
  const running = services({
    fs: fakeFs({ [app]: "" }),
    run: fakeRun().run,
    spawn: spawner.spawn,
    ollamaUrl: "http://127.0.0.1:" + ollama.address().port,
  });
  // Already running: nothing is launched.
  assert.deepEqual(await running.startOllama(), { started: false });
  assert.equal(spawner.calls.length, 0);
  ollama.close();
  let clock = 0;
  const silent = services({
    fs: fakeFs({ [app]: "" }),
    run: fakeRun().run,
    spawn: spawner.spawn,
    now: () => (clock += 20000),
  });
  await assert.rejects(silent.startOllama(), /nem válaszolt/);
  assert.equal(spawner.calls[0].file, app);
  assert.deepEqual(spawner.calls[0].args, []);
  assert.equal(spawner.calls[0].options.detached, true);
});

test("Jarvis starts from its .venv with or without its window", async () => {
  const { server, port } = await jarvisServer(() => {});
  const fs = fakeFs({
    [JARVIS + "\\jarvis.py"]: "",
    [JARVIS + "\\.venv\\Scripts\\pythonw.exe"]: "",
  });
  const spawner = fakeSpawn();
  const s = services({
    fs,
    run: fakeRun().run,
    spawn: (...args) => {
      fs.data.set(LOCAL + "\\Jarvis\\fut.json", JSON.stringify({ url: `http://127.0.0.1:${port}/?t=secret`, pid: 1 }));
      return spawner.spawn(...args);
    },
    alive: () => false,
  });
  assert.deepEqual(await s.startJarvis({ dir: JARVIS, window: false }), { started: true, status: "running" });
  assert.equal(spawner.calls[0].file, JARVIS + "\\.venv\\Scripts\\pythonw.exe");
  assert.deepEqual(spawner.calls[0].args, [JARVIS + "\\jarvis.py", "--no-window"]);
  assert.equal(spawner.calls[0].options.cwd, JARVIS);
  // Already running: a second start only opens its window.
  const again = await s.startJarvis({ dir: JARVIS, window: true });
  assert.equal(again.started, false);
  assert.deepEqual(spawner.calls[1].args, [JARVIS + "\\jarvis.py"]);
  server.close();
});

test("Jarvis start explains a missing folder or environment", async () => {
  const s = services({ fs: fakeFs({ [JARVIS + "\\jarvis.py"]: "" }), run: fakeRun().run, spawn: fakeSpawn().spawn });
  await assert.rejects(s.startJarvis({ dir: "" }), /Nincs beállítva a Jarvis mappája/);
  await assert.rejects(s.startJarvis({ dir: JARVIS }), /\.venv/);
});

test("a superseded start stops waiting quietly", async () => {
  const fs = fakeFs({ [JARVIS + "\\jarvis.py"]: "", [JARVIS + "\\.venv\\Scripts\\pythonw.exe"]: "" });
  const signal = { aborted: false };
  const s = services({ fs, run: fakeRun().run, spawn: fakeSpawn().spawn, alive: () => false,
    sleep: () => { signal.aborted = true; return Promise.resolve(); } });
  assert.deepEqual(await s.startJarvis({ dir: JARVIS, signal }), { started: true, status: "running" });
});

test("Jarvis folder: configured, from its Startup shortcut, or a common place", async () => {
  const fs = fakeFs({ [JARVIS + "\\jarvis.py"]: "", [STARTUP + "\\Jarvis.lnk"]: "" });
  const runner = fakeRun({ "powershell.exe": () => ({ stdout: `"D:\\Munka\\jarvis\\jarvis.py" --standby` }) });
  const s = services({ fs, run: runner.run });
  assert.equal(await s.findJarvis(JARVIS), JARVIS);
  fs.data.set("D:\\Munka\\jarvis\\jarvis.py", "");
  assert.equal(await s.findJarvis(""), "D:\\Munka\\jarvis");
  fs.data.delete(STARTUP + "\\Jarvis.lnk");
  assert.equal(await s.findJarvis(""), JARVIS);
  assert.equal(await s.findJarvis("relative\\path"), JARVIS);
});

test("Startup shortcuts are moved aside and can be restored", () => {
  const fs = fakeFs({ [STARTUP + "\\Ollama.lnk"]: "o", [STARTUP + "\\Jarvis.lnk"]: "j" });
  const s = services({ fs, run: fakeRun().run });
  assert.deepEqual(s.startupSnapshot(), { saved: [], ollama: true, jarvis: true });
  assert.deepEqual(s.startupTakeover(), { saved: ["ollama", "jarvis"], ollama: false, jarvis: false });
  assert.equal(fs.data.get(BACKUP + "\\Ollama.lnk"), "o");
  assert.deepEqual(s.startupRestore(), { saved: [], ollama: true, jarvis: true });
  assert.equal(fs.data.get(STARTUP + "\\Jarvis.lnk"), "j");
});

test("outside Windows nothing is touched", async () => {
  const runner = fakeRun();
  const s = createServices({ platform: "linux", env: {}, run: runner.run });
  assert.equal(s.available, false);
  assert.deepEqual(await s.status(), { ollama: null, jarvis: null });
  await assert.rejects(s.stopOllama(), /Windowsos/);
  assert.equal(runner.calls.length, 0);
});
