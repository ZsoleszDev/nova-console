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
function browserArgs(profile, key) {
  return [
    "--user-data-dir=" + profile,
    "--new-window",
    "--start-fullscreen",
    "--no-first-run",
    "--force-renderer-accessibility",
    "--disable-background-mode",
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
