const { randomUUID } = require("node:crypto");
// Foreground time from verified game observations. Monotonic time, bounded heartbeat gaps.
const MAX_GAP = 2500;
const finiteMs = (n) =>
  Number.isFinite(n) ? Math.max(0, Math.min(1e12, Math.floor(n))) : 0;
function createPlaytimeTracker({
  getState,
  persist,
  onChange = () => {},
  mono = () => performance.now(),
  wall = Date.now,
  timer = true,
}) {
  let session = null,
    last = mono(),
    heartbeat = -Infinity,
    active = false,
    credited = 0,
    counted = false,
    lastSave = last;
  let storageError = null;
  const commit = () => {
    try {
      persist();
      storageError = null;
    } catch {
      storageError =
        "A játékidő mentése nem sikerült. Ellenőrizd a szabad lemezterületet.";
    }
  };
  const state = getState();
  state.playSessions ||= [];
  // A crash never credits time while NOVA was not running. Checkpoints are already included in totals.
  if (state.playtimeActive) {
    const old = state.playtimeActive;
    if (
      old.durationMs > 0 &&
      !state.playSessions.some((s) => s.sessionId === old.sessionId)
    ) {
      state.playSessions.unshift({
        ...old,
        endedAt: old.checkpointAt,
        reason: "interrupted",
      });
      const game = state.games.find((g) => g.id === old.gameId);
      if (game) game.lastSessionMs = finiteMs(old.durationMs);
    }
    state.playSessions = state.playSessions.slice(0, 200);
    state.playtimeActive = null;
    commit();
  }
  function advance() {
    const now = mono();
    if (session && active)
      session.durationMs += Math.max(
        0,
        Math.min(now, heartbeat + MAX_GAP) - last,
      );
    last = now;
  }
  function snapshot() {
    advance();
    if (!session) return { session: null, error: storageError };
    const game = getState().games.find((g) => g.id === session.gameId);
    return {
      error: storageError,
      session: {
        ...session,
        durationMs: Math.floor(session.durationMs),
        active: active && mono() - heartbeat < MAX_GAP,
        totalMs:
          finiteMs(game?.playtimeMs) +
          Math.max(0, Math.floor(session.durationMs) - credited),
        sampledAt: wall(),
      },
    };
  }
  function checkpoint() {
    if (!session) return;
    advance();
    const s = getState(),
      game = s.games.find((g) => g.id === session.gameId),
      elapsed = Math.floor(session.durationMs);
    if (game) {
      game.playtimeMs =
        finiteMs(game.playtimeMs) + Math.max(0, elapsed - credited);
      if (elapsed > 0 && !counted) {
        game.playSessions = finiteMs(game.playSessions) + 1;
        counted = true;
      }
    }
    credited = elapsed;
    s.playtimeActive = {
      ...session,
      durationMs: elapsed,
      checkpointAt: wall(),
    };
    lastSave = mono();
    commit();
  }
  function finish(reason = "ended") {
    if (!session) return;
    checkpoint();
    const s = getState(),
      game = s.games.find((g) => g.id === session.gameId);
    if (session.durationMs >= 1) {
      s.playSessions.unshift({
        ...session,
        durationMs: Math.floor(session.durationMs),
        endedAt: wall(),
        reason,
      });
      s.playSessions = s.playSessions.slice(0, 200);
      if (game) game.lastSessionMs = Math.floor(session.durationMs);
    }
    s.playtimeActive = null;
    session = null;
    active = false;
    heartbeat = -Infinity;
    credited = 0;
    commit();
    onChange(snapshot());
  }
  function start(observation) {
    if (
      getState().settings.playtimeTracking === false ||
      !observation ||
      observation.phase !== "running"
    )
      return;
    if (session?.observationId === observation.id) return;
    if (session) finish("switched");
    if (!getState().games.some((g) => g.id === observation.gameId)) return;
    session = {
      sessionId: randomUUID(),
      observationId: observation.id,
      gameId: observation.gameId,
      name: observation.name,
      startedAt: wall(),
      durationMs: 0,
    };
    last = mono();
    heartbeat = -Infinity;
    active = false;
    credited = 0;
    counted = false;
    checkpoint();
    onChange(snapshot());
  }
  function pulse(id, isActive) {
    if (!session || session.observationId !== id) return;
    advance();
    active = isActive === true;
    heartbeat = mono();
  }
  function pause() {
    advance();
    active = false;
    heartbeat = -Infinity;
    onChange(snapshot());
  }
  function tick() {
    advance();
    if (session && mono() - lastSave >= 15000) checkpoint();
    onChange(snapshot());
  }
  const interval = timer ? setInterval(tick, 1000) : null;
  interval?.unref();
  return {
    snapshot,
    start,
    pulse,
    pause,
    finish,
    tick,
    checkpoint,
    settingsChanged(observation) {
      if (getState().settings.playtimeTracking === false) finish("disabled");
      else start(observation);
    },
    dispose() {
      if (interval) clearInterval(interval);
      finish("nova-closed");
    },
  };
}
module.exports = { createPlaytimeTracker, finiteMs };
