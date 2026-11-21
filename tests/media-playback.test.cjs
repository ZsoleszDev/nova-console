// Disney+ / HBO Max in NOVA's own Edge profile: software DRM unless the best
// quality is chosen, so the film is not black over Parsec or without HDCP.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const policy = require("../app/electron/media-policy.cjs");
const { loadState, defaults } = require("../app/electron/core.cjs");
const { validModePatch } = require("../app/electron/mode-manager.cjs");

const profile = "C:\\Users\\Player Name\\AppData\\Roaming\\NOVA\\media-profile";

test("by default NOVA's Edge uses software DRM, for every service", () => {
  for (const key of ["disney", "hbo", "youtube", "spotify"]) {
    const args = policy.browserArgs(profile, key);
    assert.equal(args[0], "--user-data-dir=" + profile);
    assert.equal(args.at(-1), policy.serviceFor(key).url);
    const features = args.find((a) => a.startsWith("--disable-features="));
    assert.deepEqual(features.slice(19).split(","), [
      "msPlayReadyWin10",
      "HardwareSecureDecryption",
      "HardwareSecureDecryptionExperiment",
      "HardwareSecureDecryptionFallback",
    ]);
    assert.ok(args.includes("--disable-direct-composition-video-overlays"));
    assert.ok(!args.includes("--disable-gpu"));
    assert.equal(args.filter((a) => a.startsWith("--disable-features=")).length, 1);
    assert.ok(!args.some((a) => a.includes("remote-debugging")));
  }
});

test("the most reliable mode also turns off GPU acceleration; best quality keeps Edge's defaults", () => {
  assert.ok(policy.browserArgs(profile, "disney", "software").includes("--disable-gpu"));
  const quality = policy.browserArgs(profile, "disney", "quality");
  assert.deepEqual(quality, [
    "--user-data-dir=" + profile,
    "--new-window",
    "--start-fullscreen",
    "--no-first-run",
    "--force-renderer-accessibility",
    "--disable-background-mode",
    "https://www.disneyplus.com/",
  ]);
  assert.deepEqual(policy.browserArgs(profile, "hbo", "bogus"), policy.browserArgs(profile, "hbo", "compatible"));
});

test("the playback setting defaults to compatible and is validated", () => {
  assert.equal(defaults.mediaPlayback, "compatible");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-"));
  const file = path.join(dir, "library.json");
  fs.writeFileSync(file, JSON.stringify({ settings: { mediaPlayback: "4k" } }));
  assert.equal(loadState(file).settings.mediaPlayback, "compatible");
  fs.writeFileSync(file, JSON.stringify({ settings: { mediaPlayback: "software" } }));
  assert.equal(loadState(file).settings.mediaPlayback, "software");
  assert.deepEqual(validModePatch({ mediaPlayback: "quality" }), { mediaPlayback: "quality" });
  assert.throws(() => validModePatch({ mediaPlayback: "4k" }));
});
