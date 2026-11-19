// The helper protocol for the taskbar: hidden while the picker or Konzol mode owns
// the screen, shown again before the helper stops.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { PassThrough } = require("node:stream");

function loadConsoleMode(spawned) {
  const electron = {
    globalShortcut: { register: () => true, unregister() {} },
    Tray: class { constructor() {} on() {} setContextMenu() {} setToolTip() {} isDestroyed() { return false; } destroy() {} },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: () => ({}) },
  };
  const childProcess = {
    ...require("node:child_process"),
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = { writable: true, lines: [], write(line) { this.lines.push(line); }, end() {}, on() {} };
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {};
      spawned.push(child);
      return child;
    },
  };
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return electron;
    if (request === "node:child_process") return childProcess;
    return original.call(this, request, ...rest);
  };
  const file = path.join(__dirname, "../app/electron/console-mode.cjs");
  delete require.cache[file];
  try {
    return require(file).createConsoleMode;
  } finally {
    Module._load = original;
  }
}

test("taskbar command follows the picker and Konzol mode, and is undone on stop", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const spawned = [];
    const createConsoleMode = loadConsoleMode(spawned);
    const settings = { consoleMode: false, hideTaskbar: true };
    let pickerVisible = true;
    const handle = Buffer.alloc(8);
    const win = new EventEmitter();
    Object.assign(win, {
      isDestroyed: () => false, getNativeWindowHandle: () => handle, setFullScreen() {}, setMinimizable() {},
      webContents: { send() {} },
    });
    const mode = createConsoleMode({
      app: { quit() {} }, window: win, getSettings: () => settings, setMode: async () => {},
      guardPaused: () => pickerVisible,
      taskbarHidden: () => settings.hideTaskbar !== false && (settings.consoleMode || pickerVisible),
    });
    const helper = spawned[0];
    mode.refreshConfig();
    const sent = () => helper.stdin.lines.filter((l) => l.startsWith("taskbar|") || l.startsWith("guard|"));
    assert.deepEqual(sent().slice(-2), ["guard|0\n", "taskbar|1\n"]);
    pickerVisible = false;
    mode.refreshConfig();
    assert.deepEqual(sent().slice(-2), ["guard|1\n", "taskbar|0\n"]);
    settings.consoleMode = true;
    mode.refreshConfig();
    assert.equal(sent().at(-1), "taskbar|1\n");
    settings.hideTaskbar = false;
    mode.refreshConfig();
    assert.equal(sent().at(-1), "taskbar|0\n");
    settings.hideTaskbar = true;
    mode.refreshConfig();
    mode.dispose();
    assert.deepEqual(helper.stdin.lines.slice(-2), ["taskbar|0\n", "stop\n"]);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
