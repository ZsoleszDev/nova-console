const path = require("node:path");
const services = Object.freeze({
  youtube: { name: "YouTube", url: "https://www.youtube.com/" },
  hbo: { name: "HBO Max", url: "https://www.hbomax.com/" },
  disney: { name: "Disney+", url: "https://www.disneyplus.com/" },
  spotify: { name: "Spotify", url: "https://open.spotify.com/" },
});
const playbackPages = Object.freeze({
  "edge-update": "edge://settings/help",
  "edge-protected": "edge://settings/content/protectedContent",
  "edge-graphics": "edge://settings/system",
});
const protectedPlaybackFor = (key) => key === "disney" || key === "hbo";
// Disney+ / HBO Max play through Edge's hardware DRM by default. Such video turns
// black, with sound, whenever the screen is captured (Parsec, Discord, OBS) or
// the display chain lacks HDCP (some TVs, adapters, Parsec's virtual display).
// Without GPU acceleration Edge has no hardware DRM path at all and plays with
// software Widevine, which is the documented fix. NOVA's own Edge profile:
// - "parsec" (default): no GPU acceleration, no PlayReady, no hardware decryption
// - "gpu": GPU acceleration kept, only PlayReady / hardware decryption off
// - "quality": Edge's default, up to 4K, black over Parsec
// msWidevinePlatform is left alone on purpose: it is Edge's (software) Widevine.
const playbackModes = Object.freeze(["parsec", "gpu", "quality"]);
// 1.11.7 values: both now mean the default.
function normalizePlayback(mode) {
  return playbackModes.includes(mode) ? mode : "parsec";
}
const SOFTWARE_DRM_FEATURES = [
  "msPlayReadyWin10",
  "HardwareSecureDecryption",
  "HardwareSecureDecryptionExperiment",
  "HardwareSecureDecryptionFallback",
];
function playbackArgs(mode = "parsec") {
  mode = normalizePlayback(mode);
  // NOVA may close a stale NOVA Edge first; no "restore pages" bubble afterwards.
  const args = ["--hide-crash-restore-bubble"];
  if (mode === "quality") return args;
  args.push(
    "--disable-features=" + SOFTWARE_DRM_FEATURES.join(","),
    "--disable-direct-composition-video-overlays",
  );
  if (mode === "parsec") args.push("--disable-gpu", "--disable-gpu-compositing");
  return args;
}
// What the running Edge must show in its command line for the mode to hold.
function expectedFlags(mode) {
  mode = normalizePlayback(mode);
  if (mode === "quality") return [];
  return mode === "parsec"
    ? ["--disable-gpu", "--disable-features=msPlayReadyWin10"]
    : ["--disable-features=msPlayReadyWin10"];
}
const commands = new Set([
  "back",
  "forward",
  "refresh",
  "fullscreen",
  "keyboard",
  "guide",
  "resume",
  "home",
  "close",
  "playpause",
  "retry",
  "escape",
  "space",
  "mode-pointer",
  "mode-links",
  "mode-arrows",
  "speed-slow",
  "speed-normal",
  "speed-fast",
  ...Object.keys(playbackPages),
  "return-service",
]);
function serviceFor(key) {
  if (typeof key !== "string" || !Object.hasOwn(services, key))
    throw Error("Ismeretlen médiaszolgáltatás.");
  return services[key];
}
// The flags hold for the whole Edge process of the NOVA profile, whichever
// service opens it first, so they are passed for every service.
function browserArgs(profile, key, playback = "parsec") {
  return [
    "--user-data-dir=" + profile,
    "--new-window",
    "--start-fullscreen",
    "--no-first-run",
    "--force-renderer-accessibility",
    "--disable-background-mode",
    ...playbackArgs(playback),
    serviceFor(key).url,
  ];
}
function browserCandidates(env) {
  return [
    ...new Set(
      [
        env["PROGRAMFILES(X86)"],
        env.PROGRAMFILES,
        env.ProgramW6432,
        env.LOCALAPPDATA,
      ]
        .filter(Boolean)
        .map((p) =>
          path.win32.join(p, "Microsoft", "Edge", "Application", "msedge.exe"),
        ),
    ),
  ];
}
function validateText(text, options = {}) {
  if (typeof text !== "string" || text.length > 2000 || text.includes("\0"))
    throw Error("Legfeljebb 2000 karaktert írj be.");
  if (
    typeof options.replace !== "boolean" ||
    typeof options.submit !== "boolean"
  )
    throw Error("Érvénytelen billentyűzetművelet.");
  return `text|${options.replace ? "1" : "0"}|${options.submit ? "1" : "0"}|${Buffer.from(text, "utf8").toString("base64")}`;
}
function validatePad(sample) {
  if (!sample || typeof sample !== "object")
    throw Error("Érvénytelen kontrolleradat.");
  for (const [key, min, max] of [
    ["buttons", 0, 65535],
    ["lx", -32767, 32767],
    ["ly", -32767, 32767],
    ["ry", -32767, 32767],
    ["lt", 0, 255],
    ["rt", 0, 255],
  ])
    if (
      !Number.isInteger(sample[key]) ||
      sample[key] < min ||
      sample[key] > max
    )
      throw Error("Érvénytelen kontrolleradat.");
  return [
    "pad",
    sample.buttons,
    sample.lx,
    sample.ly,
    sample.ry,
    sample.lt,
    sample.rt,
  ].join("|");
}
module.exports = {
  playbackModes,
  normalizePlayback,
  playbackArgs,
  expectedFlags,
  validatePad,
  protectedPlaybackFor,
  playbackPages,
  services,
  commands,
  serviceFor,
  browserArgs,
  browserCandidates,
  validateText,
};
