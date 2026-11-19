// Watches Parsec's host log and reports new client connections.
// Parsec writes lines like "[I 2024-05-01 20:15:02] Name#1234567 connected."
// Only lines written after NOVA started count; a quick reconnect after a
// dropped connection does not.
const fsDefault = require("node:fs");
const pathDefault = require("node:path");

const CONNECTED = /\]\s*(\S.*?#\d+)\s+connected\.?\s*$/i;
const DISCONNECTED = /\]\s*(\S.*?#\d+)\s+disconnected\.?\s*$/i;
const RECONNECT_MS = 120000;
const MAX_READ = 256 * 1024;

function parsecLogPaths(env = process.env, path = pathDefault.win32) {
  return [
    env.ProgramData && path.join(env.ProgramData, "Parsec", "log.txt"),
    env.APPDATA && path.join(env.APPDATA, "Parsec", "log.txt"),
  ].filter(Boolean);
}

function createParsecWatch({
  paths,
  onConnect,
  onLine = () => {},
  fs = fsDefault,
  now = Date.now,
  interval = 1500,
  setRepeat = setInterval,
  clearRepeat = clearInterval,
}) {
  const files = new Map();
  const dropped = new Map();
  let timer = null;

  function size(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return -1;
    }
  }

  function read(file, from, to) {
    const start = Math.max(from, to - MAX_READ);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(to - start);
      const count = fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.subarray(0, count).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  function line(text) {
    const gone = DISCONNECTED.exec(text);
    if (gone) {
      dropped.set(gone[1], now());
      return;
    }
    const joined = CONNECTED.exec(text);
    if (!joined) {
      // Unknown wording of this Parsec version: reported so it can be matched.
      if (/connect/i.test(text)) onLine(text.slice(0, 200));
      return;
    }
    const user = joined[1];
    const last = dropped.get(user);
    if (last !== undefined && now() - last < RECONNECT_MS) return;
    onConnect(user);
  }

  function poll() {
    for (const file of paths) {
      const state = files.get(file);
      const length = size(file);
      if (length < 0) {
        // A log that appears later is read from its start.
        files.set(file, { offset: 0, rest: "" });
        continue;
      }
      if (length < state.offset) {
        // Parsec started a new log.
        state.offset = 0;
        state.rest = "";
      }
      if (length === state.offset) continue;
      let text;
      try {
        text = state.rest + read(file, state.offset, length);
      } catch {
        continue;
      }
      state.offset = length;
      const lines = text.split(/\r?\n/);
      state.rest = lines.pop();
      for (const entry of lines) line(entry);
    }
  }

  function start() {
    // What is already in the logs is history.
    for (const file of paths) {
      const length = size(file);
      files.set(file, { offset: Math.max(0, length), rest: "" });
    }
    timer = setRepeat(poll, interval);
    timer?.unref?.();
  }

  start();
  return {
    poll,
    dispose() {
      if (timer) clearRepeat(timer);
      timer = null;
    },
  };
}

module.exports = { createParsecWatch, parsecLogPaths, RECONNECT_MS };
