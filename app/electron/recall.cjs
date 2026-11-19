// The watcher NOVA leaves behind in Jarvis / Windows mode (windows/Recall.cs).
// It is compiled once into a small windowless program, so it needs neither a
// console nor PowerShell while it runs. recall.ps1 is the fallback.
const crypto = require("node:crypto");
const fsDefault = require("node:fs");
const pathDefault = require("node:path");

const BUILD_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  "Add-Type -Path $env:NOVA_RECALL_SRC -ReferencedAssemblies @('System.dll','System.Core.dll') " +
  "-OutputAssembly $env:NOVA_RECALL_EXE -OutputType WindowsApplication";

function createRecall({
  run,
  spawn,
  dataDir,
  novaExe,
  novaPid,
  logFile,
  log = () => {},
  enabled = process.platform === "win32",
  fs = fsDefault,
  path = pathDefault,
  sourceDir = path.join(__dirname, "windows"),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const source = path.join(sourceDir, "Recall.cs");
  const dir = path.join(dataDir, "figyelo");
  let building = null;

  function exePath() {
    const hash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(source))
      .digest("hex")
      .slice(0, 12);
    return path.join(dir, `nova-figyelo-${hash}.exe`);
  }

  function build() {
    if (!enabled) return Promise.resolve(null);
    if (building) return building;
    building = (async () => {
      const exe = exePath();
      if (fs.existsSync(exe)) return exe;
      fs.mkdirSync(dir, { recursive: true });
      // Programs of earlier NOVA versions.
      for (const name of fs.readdirSync(dir))
        if (/^nova-figyelo-.*\.exe$/i.test(name) && path.join(dir, name) !== exe)
          try {
            fs.rmSync(path.join(dir, name), { force: true });
          } catch {}
      try {
        await run(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", BUILD_SCRIPT],
          {
            windowsHide: true,
            timeout: 90000,
            env: { ...process.env, NOVA_RECALL_SRC: source, NOVA_RECALL_EXE: exe },
          },
        );
      } catch (e) {
        log("figyelő fordítása nem sikerült: " + String(e?.message || e).split(/\r?\n/)[0].slice(0, 200));
      }
      return fs.existsSync(exe) ? exe : null;
    })();
    return building;
  }

  function launch(file, args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(file, args, {
          cwd: path.dirname(novaExe),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
      } catch (e) {
        log("figyelő nem indult: " + e.message);
        resolve(false);
        return;
      }
      child.once("error", (e) => {
        log("figyelő nem indult: " + e.message);
        resolve(false);
      });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  }

  // Started just before NOVA quits; it waits until NOVA is gone.
  async function start({ parsec }) {
    if (!enabled) return false;
    const exe = await Promise.race([build(), wait(15000).then(() => null)]);
    if (exe && (await launch(exe, [novaExe, String(novaPid), parsec ? "1" : "0", logFile]))) {
      log("figyelő indítva");
      return true;
    }
    const fallback = await launch("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(sourceDir, "recall.ps1"),
      "-NovaExe",
      novaExe,
      "-NovaPid",
      String(novaPid),
      "-Parsec",
      parsec ? "1" : "0",
      "-LogFile",
      logFile,
    ]);
    if (fallback) log("figyelő indítva (PowerShell)");
    return fallback;
  }

  return { build, start };
}

module.exports = { createRecall, BUILD_SCRIPT };
