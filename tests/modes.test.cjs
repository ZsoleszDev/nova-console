const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validModePatch, PLANS } = require("../app/electron/mode-manager.cjs");
const { loadState, defaults } = require("../app/electron/core.cjs");

test("new settings default to the picker with Jarvis after 30 seconds", () => {
  assert.equal(defaults.modePicker, true);
  assert.equal(defaults.defaultMode, "jarvis");
  assert.equal(defaults.modeCountdown, 30);
  assert.equal(defaults.currentMode, "");
});

test("stored mode settings are cleaned on load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-"));
  const file = path.join(dir, "library.json");
  fs.writeFileSync(file, JSON.stringify({ settings: { modeCountdown: 7, defaultMode: "xbox", currentMode: "jarvis", jarvisPath: "relative", consoleGuard: false } }));
  const s = loadState(file).settings;
  assert.equal(s.modeCountdown, 30);
  assert.equal(s.defaultMode, "jarvis");
  assert.equal(s.currentMode, "jarvis");
  assert.equal(s.jarvisPath, "");
  assert.equal(s.consoleGuard, false);
  fs.writeFileSync(file, JSON.stringify({ settings: { jarvisPath: "C:\\jarvis", modeCountdown: 60 } }));
  assert.equal(loadState(file).settings.jarvisPath, "C:\\jarvis");
  assert.equal(loadState(file).settings.modeCountdown, 60);
});

test("the picker can only change its own settings", () => {
  assert.deepEqual(validModePatch({ defaultMode: "console", modeCountdown: 45, jarvisWindow: false }), {
    defaultMode: "console", modeCountdown: 45, jarvisWindow: false,
  });
  assert.deepEqual(validModePatch({ consoleMode: true, startup: false }), {});
  assert.throws(() => validModePatch({ modeCountdown: 5 }));
  assert.throws(() => validModePatch({ defaultMode: "xbox" }));
  assert.throws(() => validModePatch({ modePicker: "igen" }));
});

test("Konzol and Windows free the GPU; Jarvis starts Ollama before Jarvis", () => {
  for (const mode of ["console", "windows"])
    assert.deepEqual(PLANS[mode].slice(0, 2).map(([id]) => id), ["jarvis-stop", "ollama-stop"]);
  assert.deepEqual(PLANS.jarvis.map(([id]) => id), ["ollama-start", "jarvis-start", "nova-desktop"]);
});
