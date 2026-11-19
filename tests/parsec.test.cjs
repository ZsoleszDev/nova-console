const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createParsecWatch, parsecLogPaths } = require("../app/electron/parsec-watch.cjs");

function setup(initial = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsec-"));
  const log = path.join(dir, "log.txt");
  if (initial !== null) fs.writeFileSync(log, initial);
  let clock = 1_000_000;
  const seen = [];
  const watch = createParsecWatch({
    paths: [log, path.join(dir, "missing.txt")],
    onConnect: (user) => seen.push(user),
    now: () => clock,
    setRepeat: () => null,
    clearRepeat: () => {},
  });
  return { log, seen, watch, tick: (ms) => (clock += ms), add: (text) => fs.appendFileSync(log, text) };
}

test("only connections written after NOVA started count", () => {
  const t = setup("[I 2026-11-19 20:00:00] Zsolt#1234567 connected.\n");
  t.watch.poll();
  assert.deepEqual(t.seen, []);
  t.add("[I 2026-11-19 20:05:00] Encoder: nvenc h265\n[I 2026-11-19 20:05:01] Zsolt#1234567 connected.\r\n");
  t.watch.poll();
  assert.deepEqual(t.seen, ["Zsolt#1234567"]);
  t.watch.poll();
  assert.deepEqual(t.seen, ["Zsolt#1234567"]);
});

test("a quick reconnect after a drop is ignored, a later one counts", () => {
  const t = setup("");
  t.add("[I 2026-11-19 20:00:00] Zsolt#1 connected.\n");
  t.watch.poll();
  t.add("[I 2026-11-19 20:10:00] Zsolt#1 disconnected.\n");
  t.watch.poll();
  t.tick(30_000);
  t.add("[I 2026-11-19 20:10:30] Zsolt#1 connected.\n");
  t.watch.poll();
  assert.deepEqual(t.seen, ["Zsolt#1"]);
  t.add("[I 2026-11-19 20:12:00] Zsolt#1 disconnected.\n");
  t.watch.poll();
  t.tick(180_000);
  t.add("[I 2026-11-19 20:15:00] Zsolt#1 connected.\n");
  t.watch.poll();
  assert.deepEqual(t.seen, ["Zsolt#1", "Zsolt#1"]);
});

test("half-written lines wait for their end; other lines are ignored", () => {
  const t = setup("");
  t.add("[I 2026-11-19 20:00:00] Connected to signaling server\n[I 2026-11-19 20:00:01] Zsolt#77 conn");
  t.watch.poll();
  assert.deepEqual(t.seen, []);
  t.add("ected.\n");
  t.watch.poll();
  assert.deepEqual(t.seen, ["Zsolt#77"]);
});

test("a new log after Parsec restarts and a log that appears later are read", () => {
  const t = setup(null);
  t.watch.poll();
  t.add("[I 2026-11-19 21:00:00] Laptop User#42 connected.\n");
  t.watch.poll();
  assert.deepEqual(t.seen, ["Laptop User#42"]);
  fs.writeFileSync(t.log, "[I 2026-11-19 22:00:00] Zsolt#5 connected.\n");
  t.watch.poll();
  assert.deepEqual(t.seen, ["Laptop User#42", "Zsolt#5"]);
});

test("both Parsec log locations are watched", () => {
  assert.deepEqual(parsecLogPaths({ ProgramData: "C:\\ProgramData", APPDATA: "C:\\Users\\Z\\AppData\\Roaming" }), [
    "C:\\ProgramData\\Parsec\\log.txt",
    "C:\\Users\\Z\\AppData\\Roaming\\Parsec\\log.txt",
  ]);
});

test("lines about connecting in an unknown wording are reported for adjusting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsec-"));
  const log = path.join(dir, "log.txt");
  fs.writeFileSync(log, "");
  const seen = [], lines = [];
  const watch = createParsecWatch({ paths: [log], onConnect: (u) => seen.push(u), onLine: (l) => lines.push(l), setRepeat: () => null });
  fs.appendFileSync(log, "[I 2026-11-19 20:00:00] Client connected from 192.168.1.20\n[I 2026-11-19 20:00:01] Encoder ready\n");
  watch.poll();
  assert.deepEqual(seen, []);
  assert.deepEqual(lines, ["[I 2026-11-19 20:00:00] Client connected from 192.168.1.20"]);
});
