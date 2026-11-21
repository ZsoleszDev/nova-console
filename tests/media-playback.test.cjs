// Disney+ / HBO Max in NOVA's own Edge profile: by default without GPU
// acceleration and hardware DRM, so the film is not black over Parsec or
// without HDCP. Edge's software Widevine (msWidevinePlatform) stays on.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const policy = require("../app/electron/media-policy.cjs");
const { loadState, defaults } = require("../app/electron/core.cjs");
const { validModePatch } = require("../app/electron/mode-manager.cjs");
const { createEdgeProfile } = require("../app/electron/edge-profile.cjs");

const profile = "C:\\Users\\Player Name\\AppData\\Roaming\\NOVA\\media-profile";
const FEATURES = "--disable-features=msPlayReadyWin10,HardwareSecureDecryption,HardwareSecureDecryptionExperiment,HardwareSecureDecryptionFallback";

test("by default NOVA's Edge runs without GPU acceleration and hardware DRM, for every service", () => {
  for (const key of ["disney", "hbo", "youtube", "spotify"]) {
    const args = policy.browserArgs(profile, key);
    assert.equal(args[0], "--user-data-dir=" + profile);
    assert.equal(args.at(-1), policy.serviceFor(key).url);
    for (const flag of [FEATURES, "--disable-gpu", "--disable-gpu-compositing", "--disable-direct-composition-video-overlays", "--hide-crash-restore-bubble"])
      assert.ok(args.includes(flag), flag);
    assert.equal(args.filter((a) => a.startsWith("--disable-features=")).length, 1);
    assert.ok(!args.some((a) => /msWidevinePlatform/.test(a)), "software Widevine must stay available");
    assert.ok(!args.some((a) => a.includes("remote-debugging")));
  }
});

test("GPU mode keeps acceleration; best quality keeps Edge's defaults; old values mean the default", () => {
  const gpu = policy.browserArgs(profile, "disney", "gpu");
  assert.ok(gpu.includes(FEATURES));
  assert.ok(!gpu.includes("--disable-gpu"));
  assert.deepEqual(policy.browserArgs(profile, "disney", "quality"), [
    "--user-data-dir=" + profile, "--new-window", "--start-fullscreen", "--no-first-run",
    "--force-renderer-accessibility", "--disable-background-mode", "--hide-crash-restore-bubble",
    "https://www.disneyplus.com/",
  ]);
  for (const old of ["compatible", "software", "bogus", undefined])
    assert.deepEqual(policy.browserArgs(profile, "hbo", old), policy.browserArgs(profile, "hbo", "parsec"));
  assert.deepEqual(policy.expectedFlags("parsec"), ["--disable-gpu", "--disable-features=msPlayReadyWin10"]);
  assert.deepEqual(policy.expectedFlags("quality"), []);
});

test("the playback setting defaults to parsec; 1.11.7 values move to it", () => {
  assert.equal(defaults.mediaPlayback, "parsec");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-"));
  const file = path.join(dir, "library.json");
  for (const [stored, loaded] of [["compatible", "parsec"], ["software", "parsec"], ["gpu", "gpu"], ["quality", "quality"], ["4k", "parsec"]]) {
    fs.writeFileSync(file, JSON.stringify({ settings: { mediaPlayback: stored } }));
    assert.equal(loadState(file).settings.mediaPlayback, loaded, stored);
  }
  assert.deepEqual(validModePatch({ mediaPlayback: "gpu" }), { mediaPlayback: "gpu" });
  assert.throws(() => validModePatch({ mediaPlayback: "compatible" }));
});

function edge({ running = [], after = running } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-"));
  const calls = [], logs = [];
  let listed = 0;
  const run = async (file, args, options) => {
    calls.push({ file, args, env: options?.env });
    if (file === "powershell.exe") return { stdout: (listed++ === 0 ? running : after).map((p) => p.pid + "|" + p.command).join("\n") };
    return { stdout: "" };
  };
  const e = createEdgeProfile({ run, log: (t) => logs.push(t), enabled: true, path, wait: async () => {} });
  return { e, dir, calls, logs };
}

test("a stale NOVA Edge is closed before a fresh start, and Edge's own acceleration setting follows the mode", async () => {
  const t = edge({ running: [{ pid: 501, command: "msedge.exe --user-data-dir=X" }, { pid: 502, command: "msedge.exe --type=renderer" }] });
  fs.writeFileSync(path.join(t.dir, "Local State"), JSON.stringify({ browser: { last_redirect_origin: "" }, profile: { info_cache: {} } }));
  await t.e.prepare(t.dir, "parsec");
  assert.equal(t.calls[0].env.NOVA_EDGE_PROFILE, t.dir);
  assert.ok(!t.calls[0].args.at(-1).includes('"'), "no double quotes in -Command");
  assert.deepEqual(t.calls.filter((c) => c.file === "taskkill.exe").map((c) => c.args), [["/F", "/T", "/PID", "501"], ["/F", "/T", "/PID", "502"]]);
  const state = JSON.parse(fs.readFileSync(path.join(t.dir, "Local State"), "utf8"));
  assert.deepEqual(state.hardware_acceleration_mode, { enabled: false });
  assert.equal(state.hardware_acceleration_mode_previous, false);
  assert.deepEqual(state.profile, { info_cache: {} }, "other settings are kept");
  assert.match(t.logs[0], /régi NOVA Edge leállítva \(2 folyamat\)/);
  await t.e.prepare(t.dir, "quality");
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, "Local State"), "utf8")).hardware_acceleration_mode.enabled, true);
});

test("a fresh profile gets the setting; an unreadable Local State is left alone", async () => {
  const t = edge();
  const fresh = path.join(t.dir, "new-profile");
  await t.e.prepare(fresh, "parsec");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, "Local State"), "utf8")).hardware_acceleration_mode, { enabled: false });
  fs.writeFileSync(path.join(t.dir, "Local State"), "{broken");
  await t.e.prepare(t.dir, "parsec");
  assert.equal(fs.readFileSync(path.join(t.dir, "Local State"), "utf8"), "{broken");
  assert.ok(t.logs.some((l) => l.includes("nem olvasható")));
  assert.equal(t.calls.filter((c) => c.file === "taskkill.exe").length, 0);
});

test("after the start the real Edge flags are checked and logged", async () => {
  const ok = edge({ running: [{ pid: 7, command: 'msedge.exe --user-data-dir=X --disable-gpu --disable-features=msPlayReadyWin10,HardwareSecureDecryption https://www.disneyplus.com/' }, { pid: 8, command: "msedge.exe --type=gpu-process" }] });
  await ok.e.verify("X", "parsec", policy.expectedFlags("parsec"));
  assert.match(ok.logs.at(-1), /^Edge fut, lejátszás: parsec/);
  const stale = edge({ running: [{ pid: 9, command: "msedge.exe --user-data-dir=X https://www.disneyplus.com/" }] });
  await stale.e.verify("X", "parsec", policy.expectedFlags("parsec"));
  assert.match(stale.logs.at(-1), /^FIGYELEM: .*hiányzik: --disable-gpu --disable-features=msPlayReadyWin10/);
});
