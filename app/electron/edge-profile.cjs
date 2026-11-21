// NOVA's own Edge profile (media-profile). Edge reads its start flags only when
// the profile's browser starts fresh, so before NOVA opens Disney+ / HBO Max:
// 1. a NOVA Edge still running without NOVA's control is closed,
// 2. the profile's own "Use graphics acceleration" setting (Local State) is set
//    to match the playback mode, the same value Edge's settings page writes,
// and after the start NOVA checks which flags Edge really runs with (logged).
const fsDefault = require("node:fs");
const pathDefault = require("node:path");

// "pid|command line" for every msedge.exe of the NOVA profile.
const PROFILE_PROCESSES =
  "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
  "$p=$env:NOVA_EDGE_PROFILE;" +
  "@(Get-CimInstance Win32_Process -Filter 'Name=''msedge.exe''' | " +
  "Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($p,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | " +
  "ForEach-Object { [string]$_.ProcessId + '|' + $_.CommandLine }) -join [char]10";

function createEdgeProfile({
  run,
  log = () => {},
  enabled = process.platform === "win32",
  fs = fsDefault,
  path = pathDefault.win32,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  async function processes(profile) {
    try {
      const { stdout } = await run(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROFILE_PROCESSES],
        {
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, NOVA_EDGE_PROFILE: profile },
        },
      );
      return String(stdout)
        .split(/\r?\n/)
        .map((line) => {
          const at = line.indexOf("|");
          const pid = Number(line.slice(0, at));
          return at > 0 && Number.isSafeInteger(pid) && pid > 0
            ? { pid, command: line.slice(at + 1) }
            : null;
        })
        .filter(Boolean);
    } catch {
      return null;
    }
  }

  // Edge's own setting: Settings > System > Use graphics acceleration.
  function writeLocalState(profile, mode) {
    const file = path.join(profile, "Local State");
    let data = {};
    if (fs.existsSync(file)) {
      try {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        log("Edge Local State nem olvasható, változatlan maradt");
        return false;
      }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const accelerated = mode !== "parsec";
    const current =
      data.hardware_acceleration_mode && typeof data.hardware_acceleration_mode === "object"
        ? data.hardware_acceleration_mode
        : {};
    if (current.enabled === accelerated && data.hardware_acceleration_mode_previous === accelerated)
      return true;
    data.hardware_acceleration_mode = { ...current, enabled: accelerated };
    data.hardware_acceleration_mode_previous = accelerated;
    try {
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(file + ".nova", JSON.stringify(data), "utf8");
      fs.renameSync(file + ".nova", file);
      return true;
    } catch (e) {
      log("Edge Local State nem írható: " + e.message);
      return false;
    }
  }

  // Before a fresh start of NOVA's Edge.
  async function prepare(profile, mode) {
    if (!enabled) return;
    const running = await processes(profile);
    if (running?.length) {
      log(`régi NOVA Edge leállítva (${running.length} folyamat), hogy az új beállítás érvényes legyen`);
      for (const { pid } of running)
        try {
          await run("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
            windowsHide: true,
            timeout: 15000,
          });
        } catch {}
      await wait(800);
    }
    writeLocalState(profile, mode);
  }

  // After the start: which flags does the Edge browser process really have?
  async function verify(profile, mode, expected) {
    if (!enabled) return;
    await wait(4000);
    const running = await processes(profile);
    if (running === null) return log("Edge-ellenőrzés nem sikerült");
    const browser = running.find((p) => !/\s--type=/.test(p.command));
    if (!browser) return log("Edge-ellenőrzés: a NOVA Edge-e nem fut");
    const missing = expected.filter((flag) => !browser.command.includes(flag));
    const shown = expected.length ? expected.join(" ") : "(az Edge alapbeállítása)";
    if (missing.length)
      log(`FIGYELEM: a NOVA Edge-e nem a beállított kapcsolókkal fut (${mode}); hiányzik: ${missing.join(" ")}`);
    else log(`Edge fut, lejátszás: ${mode}; kapcsolók: ${shown}`);
  }

  return { prepare, verify, writeLocalState, processes };
}

module.exports = { createEdgeProfile, PROFILE_PROCESSES };
