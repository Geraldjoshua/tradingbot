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

// ---- Inbound ping monitor --------------------------------------------------
// "Is the keep-alive working?" can't be answered from GitHub's green checkmark
// alone — the Action can report success while the request never reaches this
// service (wrong URL, service asleep and slow to wake, DNS). So we record every
// inbound hit on /api/health and expose the gap. If the last external ping was
// 20 minutes ago, you are about to be spun down regardless of what GitHub says.
const pings = { last: null, lastExternal: null, count: 0, externalCount: 0, bootedAt: Date.now() };

export function notePing({ external = false } = {}) {
  const now = Date.now();
  pings.last = now; pings.count++;
  if (external) { pings.lastExternal = now; pings.externalCount++; }
}

export function pingStatus() {
  const now = Date.now();
  const mins = (t) => (t ? +((now - t) / 60000).toFixed(1) : null);
  const sinceExternal = mins(pings.lastExternal);
  const upMin = (now - pings.bootedAt) / 60000;
  // Render free spins down after 15 min with no inbound request.
  const risk = sinceExternal == null
    ? (upMin > 16 ? "no external pings seen since boot — service will sleep" : null)
    : (sinceExternal > 14 ? `last external ping ${sinceExternal}m ago — sleep imminent`
      : sinceExternal > 8 ? `last external ping ${sinceExternal}m ago` : null);
  return {
    uptimeMinutes: +upMin.toFixed(1),
    totalRequests: pings.count,
    externalPings: pings.externalCount,
    minutesSinceExternalPing: sinceExternal,
    minutesSinceAnyRequest: mins(pings.last),
    selfPingEveryMin: process.env.KEEPALIVE === "off" ? null : INTERVAL_MIN,
    healthy: sinceExternal != null && sinceExternal <= 14,
    warning: risk,
  };
}

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
