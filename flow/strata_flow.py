"""
OptionStrat multi-feed scraper → one CSV per feed per day.

Each feed loads /flow/live and applies a named SAVED FILTER by clicking
"Your Filters" → <preset name> in the sidebar (the site stores filters in memory,
not the URL, so we drive the UI). Then it scrapes the filtered rows.

  live    : no filter                  -> flow_YYYY-MM-DD.csv
  unusual : "Highly Unusual"           -> flow_unusual_YYYY-MM-DD.csv
  knows   : "Someone Knows Something"  -> flow_knows_YYYY-MM-DD.csv

IMPORTANT — headed vs headless:
  These presets appear WITHOUT logging in (they're built-in). So no login is needed.
  The only reason to run headed (HEADLESS=False) is that this site sometimes serves
  a *headless* browser a blocked/empty page. Try HEADLESS=True; if rows don't load or
  the filter clicks time out, set it back to False (a visible window always works).
  A persistent profile (./optionstrat_profile) is kept just for consistent behavior.

If your preset names differ, edit the `filter` strings in TARGETS to match EXACTLY.

Setup:  pip install playwright ; playwright install chromium
Run:    python optionstrat_flow_scraper.py
"""

import csv
import time
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

import os

URL = "https://optionstrat.com/flow/live"
# All tunables are env-overridable so the same file works locally and in a
# container (see flow/scraper_service.py + Dockerfile.scraper).
PROFILE_DIR = os.environ.get("OPTIONSTRAT_PROFILE_DIR", "optionstrat_profile")
POLL_SECONDS = int(os.environ.get("SCRAPER_POLL_SECONDS", "3"))
STALE_RELOAD_SECONDS = int(os.environ.get("SCRAPER_STALE_SECONDS", "180"))
# Headless by default (required in a container — there is no display).
HEADLESS = os.environ.get("SCRAPER_HEADLESS", "true").lower() not in ("0", "false", "no")
# Where day-CSVs are written. In a container this points at a writable volume.
OUT_DIR = os.environ.get("OPTIONSTRAT_DIR", ".")

ALL_TARGETS = {
    "live":    {"label": "live",    "filter": None},
    "unusual": {"label": "unusual", "filter": "Highly Unusual"},
    "knows":   {"label": "knows",   "filter": "In The Know"},   # exp<14d + Volume>OI
}

# Each feed is its own browser TAB, and each tab is the dominant memory cost
# (~80-150MB for this live virtualized list). On a small/metered host, run one.
#
#   SCRAPER_FEEDS=live                 lean: ~1 tab. The broad book — this is the
#                                      one discovery ranking actually needs, since
#                                      it supplies bull/bear premium per ticker.
#   SCRAPER_FEEDS=live,unusual,knows   full: 3 tabs. Adds the higher-signal books,
#                                      which become the in_unusual / in_knows
#                                      ranking boosts (x1.25 / x1.5).
#
# Dropping to live-only costs you those boosts, not the ranking itself.
_want = [s.strip().lower() for s in os.environ.get("SCRAPER_FEEDS", "live").split(",") if s.strip()]
TARGETS = [ALL_TARGETS[k] for k in _want if k in ALL_TARGETS] or [ALL_TARGETS["live"]]

EXTRACT_JS = r"""
() => {
  const pick = (root, sel) => { const e = root.querySelector(sel); return e ? e.textContent.replace(/\u200b/g,'').trim() : null; };
  const unders = [...document.querySelectorAll('[class*="FlowRow_underlying"]')];
  return unders.map(u => {
    let root = u.closest('[class*="FlowRow_container"]')
            || (u.parentElement && u.parentElement.parentElement) || u;
    const cls = root.className || '';
    const s = cls.match(/(very-bullish|bullish|very-bearish|bearish|neutral)/);
    const premEl = root.querySelector('[class*="FlowRow_premium"]');
    return {
      ticker:     u.textContent.replace(/\u200b/g,'').trim(),
      premium:    premEl && premEl.firstChild ? premEl.firstChild.textContent.trim() : null,
      premiumTag: (premEl && premEl.querySelector('sup')) ? premEl.querySelector('sup').textContent.trim() : null,
      strategy:   pick(root, '[class*="FlowRow_strategy"]'),
      badge:      pick(root, '[class*="FlowBadge_badge"]'),
      expiration: pick(root, '[class*="FlowRow_expiration"]'),
      time:       pick(root, '[class*="FlowRow_time"]'),
      sentiment:  s ? s[1] : 'neutral',
    };
  }).filter(r => r.ticker);
}
"""

FIELDS = ["captured", "ticker", "premium", "premiumTag", "strategy", "badge",
          "expiration", "time", "sentiment"]


def row_key(r):
    return (r["ticker"], r["strategy"], r["expiration"], r["time"], r["premium"])


def today_str():
    return datetime.now().strftime("%Y-%m-%d")


def file_for(label, day):
    base = Path(OUT_DIR)
    base.mkdir(parents=True, exist_ok=True)
    return base / (f"flow_{day}.csv" if label == "live" else f"flow_{label}_{day}.csv")


def open_day(label, day):
    path = file_for(label, day)
    seen = set()
    new = not path.exists()
    if not new:
        with path.open(newline="") as rf:
            for r in csv.DictReader(rf):
                seen.add(row_key(r))
        print(f"[{label}] loaded {len(seen)} existing from {path}")
    f = path.open("a", newline="")
    w = csv.DictWriter(f, fieldnames=FIELDS)
    if new:
        w.writeheader(); f.flush()
    return path, f, w, seen


def apply_saved_filter(page, name):
    """Sidebar: click 'Your Filters' then the named preset.
    Uses dispatch_event so transient toast overlays can't intercept the click."""
    try:
        yf = page.get_by_text("Your Filters", exact=True).first
        yf.wait_for(state="visible", timeout=10000)
        yf.dispatch_event("click")
        page.wait_for_timeout(900)
        item = page.get_by_text(name, exact=True).first
        item.wait_for(state="visible", timeout=10000)
        item.scroll_into_view_if_needed()
        item.dispatch_event("click")   # bypass toast/overlay pointer interception
        page.wait_for_timeout(1500)
        print(f"  applied filter: {name}")
        return True
    except Exception as e:
        print(f"  !! could not apply filter '{name}': {e}")
        print("     (logged in? preset exists under 'Your Filters'? exact name?)")
        return False


def main():
    day = today_str()
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=HEADLESS,
            viewport={"width": 1440, "height": 900},
            # Container/datacenter hardening. --no-sandbox and --disable-dev-shm-usage
            # are required in Docker (no user namespaces, tiny /dev/shm); the rest
            # reduce the headless fingerprint the site uses to serve a blank page.
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--disable-features=IsolateOrigins,site-per-process",
                "--window-size=1440,900",
                # Memory-lean flags — RAM is the binding constraint on a small
                # host. These drop background/extra processes and cap the JS heap.
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-client-side-phishing-detection",
                "--disable-component-update",
                "--disable-default-apps",
                "--mute-audio",
                "--no-zygote",
                f"--js-flags=--max-old-space-size={os.environ.get('SCRAPER_JS_HEAP_MB', '256')}",
            ],
            locale="en-US",
            timezone_id=os.environ.get("SCRAPER_TZ", "America/New_York"),
            user_agent=os.environ.get(
                "SCRAPER_UA",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"))

        # Force the page to always report as VISIBLE so the live feed doesn't pause/
        # throttle when the tab is headless/backgrounded (Page Visibility API).
        ctx.add_init_script("""
            Object.defineProperty(document, 'hidden', {get: () => false, configurable: true});
            Object.defineProperty(document, 'visibilityState', {get: () => 'visible', configurable: true});
            document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
            // Headless tells on itself in a few well-known places. Mask the ones
            // bot-detection scripts read most often, so a headless container has
            // a better chance of being served the real feed instead of a shell.
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US','en']});
            Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
            window.chrome = window.chrome || {runtime: {}};
            const origQuery = navigator.permissions && navigator.permissions.query;
            if (origQuery) navigator.permissions.query = (p) =>
              p && p.name === 'notifications'
                ? Promise.resolve({state: Notification.permission})
                : origQuery(p);
        """)

        feeds = []
        for t in TARGETS:
            page = ctx.new_page()
            page.goto(URL, wait_until="domcontentloaded")
            page.wait_for_timeout(3500)
            if t["filter"]:
                apply_saved_filter(page, t["filter"])
            try:
                page.eval_on_selector("#list", "el => { el.scrollTop = 0; el.scrollTop = 50; }")
            except Exception:
                pass
            n = page.evaluate("() => document.querySelectorAll('[class*=\"FlowRow_underlying\"]').length")
            print(f"[{t['label']}] rows visible: {n}")
            path, f, w, seen = open_day(t["label"], day)
            feeds.append({"label": t["label"], "page": page, "path": path,
                          "f": f, "w": w, "seen": seen,
                          "filter": t["filter"], "last_added": time.time()})

        print("Scraping all feeds… Ctrl+C to stop.")
        try:
            while True:
                now = today_str()
                stamp = datetime.now().isoformat(timespec="seconds")
                for fd in feeds:
                    if now != day:
                        fd["f"].close()
                        fd["path"], fd["f"], fd["w"], fd["seen"] = open_day(fd["label"], now)
                        fd["last_added"] = time.time()
                    # Re-scroll to top each poll so newly-prepended rows render
                    # (virtualized list drops rows above the viewport otherwise).
                    try:
                        fd["page"].eval_on_selector("#list", "el => { el.scrollTop = 0; }")
                    except Exception:
                        pass
                    try:
                        rows = fd["page"].evaluate(EXTRACT_JS)
                    except Exception:
                        rows = []
                    added = 0
                    for r in rows:
                        k = row_key(r)
                        if k in fd["seen"]:
                            continue
                        fd["seen"].add(k)
                        r["captured"] = stamp
                        fd["w"].writerow(r)
                        added += 1
                    if added:
                        fd["f"].flush()
                        fd["last_added"] = time.time()
                        print(f"[{fd['label']}] +{added} (today {len(fd['seen'])})")
                    # Watchdog: if a feed has added nothing for a while, the live
                    # stream likely stalled — reload the page and re-apply its filter.
                    elif time.time() - fd["last_added"] > STALE_RELOAD_SECONDS:
                        print(f"[{fd['label']}] stale {STALE_RELOAD_SECONDS}s — reloading feed")
                        try:
                            fd["page"].goto(URL, wait_until="domcontentloaded")
                            fd["page"].wait_for_timeout(3000)
                            if fd["filter"]:
                                apply_saved_filter(fd["page"], fd["filter"])
                            fd["page"].eval_on_selector("#list", "el => { el.scrollTop = 0; }")
                        except Exception as e:
                            print(f"[{fd['label']}] reload failed: {e}")
                        fd["last_added"] = time.time()   # reset so we don't reload every poll
                day = now
                time.sleep(POLL_SECONDS)
        except KeyboardInterrupt:
            print("\nStopped.")
            for fd in feeds:
                print(f"  [{fd['label']}] {len(fd['seen'])} -> {fd['path']}")
        finally:
            ctx.close()
            for fd in feeds:
                fd["f"].close()


if __name__ == "__main__":
    main()
