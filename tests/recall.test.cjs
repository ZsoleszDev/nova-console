const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createRecall } = require("../app/electron/recall.cjs");

function fakeSpawn({ fail = () => false } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => (fail(file) ? child.emit("error", Error("blocked")) : child.emit("spawn")));
    return child;
  };
  return { spawn, calls };
}

function setup({ build = true, fail } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-"));
  const runs = [];
  const run = async (file, args, options) => {
    runs.push({ file, args, env: options.env });
    if (build) fs.writeFileSync(options.env.NOVA_RECALL_EXE, "exe");
    else throw Error("Add-Type failed\nmore");
    return { stdout: "" };
  };
  const spawner = fakeSpawn({ fail });
  const logs = [];
  const recall = createRecall({
    run, spawn: spawner.spawn, dataDir, novaExe: "C:\\NOVA\\NOVA.exe", novaPid: 4242,
    logFile: "C:\\naplo.txt", log: (t) => logs.push(t), enabled: true, wait: () => new Promise(() => {}),
  });
  return { recall, runs, spawner, logs, dataDir };
}

test("the watcher is compiled once into a windowless program and started with NOVA's details", async () => {
  const t = setup();
  const exe = await t.recall.build();
  assert.match(path.basename(exe), /^nova-figyelo-[0-9a-f]{12}\.exe$/);
  assert.equal(await t.recall.build(), exe);
  assert.equal(t.runs.length, 1);
  assert.match(t.runs[0].args.at(-1), /-OutputType WindowsApplication/);
  assert.ok(!t.runs[0].args.at(-1).includes('"'));
  assert.ok(t.runs[0].env.NOVA_RECALL_SRC.endsWith(path.join("windows", "Recall.cs")));
  assert.equal(await t.recall.start({ parsec: true }), true);
  const started = t.spawner.calls[0];
  assert.equal(started.file, exe);
  assert.deepEqual(started.args, ["C:\\NOVA\\NOVA.exe", "4242", "1", "C:\\naplo.txt"]);
  assert.equal(started.options.detached, true);
  assert.deepEqual(t.logs, ["figyelő indítva"]);
});

test("without the compiled program the PowerShell watcher starts, with the log file", async () => {
  const t = setup({ build: false });
  assert.equal(await t.recall.start({ parsec: false }), true);
  const started = t.spawner.calls[0];
  assert.equal(started.file, "powershell.exe");
  assert.ok(started.args.includes("-File"));
  assert.deepEqual(started.args.slice(-8), ["-NovaExe", "C:\\NOVA\\NOVA.exe", "-NovaPid", "4242", "-Parsec", "0", "-LogFile", "C:\\naplo.txt"]);
  assert.deepEqual(t.logs, ["figyelő fordítása nem sikerült: Add-Type failed", "figyelő indítva (PowerShell)"]);
});

test("a blocked program falls back to PowerShell; old versions are removed", async () => {
  const t = setup({ fail: (file) => file.endsWith(".exe") && file !== "powershell.exe" });
  fs.mkdirSync(path.join(t.dataDir, "figyelo"), { recursive: true });
  fs.writeFileSync(path.join(t.dataDir, "figyelo", "nova-figyelo-000000000000.exe"), "old");
  assert.equal(await t.recall.start({ parsec: true }), true);
  assert.deepEqual(t.spawner.calls.map((c) => path.basename(c.file)).slice(-1), ["powershell.exe"]);
  assert.deepEqual(fs.readdirSync(path.join(t.dataDir, "figyelo")).filter((n) => n.includes("000000")), []);
  assert.deepEqual(t.logs, ["figyelő nem indult: blocked", "figyelő indítva (PowerShell)"]);
});

test("outside Windows nothing is started", async () => {
  const spawner = fakeSpawn();
  const recall = createRecall({ run: async () => {}, spawn: spawner.spawn, dataDir: os.tmpdir(), novaExe: "x", novaPid: 1, logFile: "y", enabled: false });
  assert.equal(await recall.start({ parsec: true }), false);
  assert.equal(spawner.calls.length, 0);
});
