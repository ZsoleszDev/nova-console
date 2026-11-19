function shouldShowClock({
  enabled,
  locked,
  mediaOpen,
  now,
  lastReset,
  systemIdleMs,
  padIdleMs,
  padHeartbeat,
  timeoutMs,
}) {
  return (
    !!enabled &&
    !locked &&
    !mediaOpen &&
    Number.isFinite(systemIdleMs) &&
    Number.isFinite(padIdleMs) &&
    now - padHeartbeat < 3000 &&
    now - lastReset >= timeoutMs &&
    systemIdleMs >= timeoutMs &&
    padIdleMs >= timeoutMs
  );
}
function createBatteryNotice() {
  let seen = new Set();
  return (pad) => {
    const key = String(pad.index ?? 0);
    if (!pad.connected) return false;
    if (pad.power !== "battery" || pad.battery > 1) {
      seen.delete(key);
      return false;
    }
    if (pad.battery < 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
module.exports = { shouldShowClock, createBatteryNotice };
