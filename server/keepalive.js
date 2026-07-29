// Keep-alive self-ping — helps a Render FREE web service avoid the idle
// spin-down (~15 min with no inbound HTTP).
//
// IMPORTANT: this only keeps the service awake while it is ALREADY running. Once
// Render has spun it down, the process (and this timer) is frozen, so it cannot
// wake itself. For reliable 24/7 uptime you ALSO need an EXTERNAL pinger hitting
// the public /api/health URL — see .github/workflows/keepalive.yml. Treat this
// self-ping as a helper, not the whole solution.
//
// Render injects RENDER_EXTERNAL_URL automatically. Disable with KEEPALIVE=off.

const INTERVAL_MIN = parseInt(process.env.KEEPALIVE_MIN || "12", 10); // < 15
let timer = null;

export function startKeepAlive() {
  if (process.env.KEEPALIVE === "off") return;
  const base = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
  if (!base) {
    console.log("[keepalive] no RENDER_EXTERNAL_URL — self-ping disabled (fine for local).");
    return;
  }
  if (timer) return;
  const url = `${base.replace(/\/$/, "")}/api/health`;
  const ms = Math.max(1, INTERVAL_MIN) * 60 * 1000;
  timer = setInterval(async () => {
    try {
      const r = await fetch(url, { headers: { "x-keepalive": "1" } });
      console.log(`[keepalive] ping ${url} -> ${r.status}`);
    } catch (e) {
      console.log(`[keepalive] ping failed: ${String(e.message || e)}`);
    }
  }, ms);
  if (timer.unref) timer.unref();
  console.log(`[keepalive] self-ping every ${INTERVAL_MIN}m -> ${url}`);
}
