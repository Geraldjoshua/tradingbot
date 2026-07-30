"""
Scraper supervisor — the hands-off flow pipeline.

Runs as its own always-on process (Render worker, VPS, or any spare box) and
keeps the deployed trading app supplied with OptionStrat flow with no manual
steps:

    strata_flow.py  (child process, scrapes continuously into day-CSVs)
          │
          ├── every BUILD_EVERY_MIN:
          │      optionstrat_master_builder.py   day-CSVs -> master .xlsx
          │      build_flow_cache.py             masters  -> flow_cache.json
          │      push_flow_cache.py              cache    -> POST /api/flow-cache
          │
          └── watchdog: if the scraper dies or stops producing, restart it.

Everything is env-driven:

    OPTIONSTRAT_DIR      where CSVs/masters/cache live       (default /data)
    BUILD_EVERY_MIN      build+push cadence                  (default 15)
    FLOW_PUSH_URL        deployed app base URL               (enables pushing)
    FLOW_PUSH_TOKEN      shared secret, matches the server
    SCRAPER_HEADLESS     true in containers                  (default true)
    MARKET_HOURS_ONLY    only scrape 09:30-16:00 ET weekdays (default true)

Why market-hours gating: OptionStrat's live feed is quiet outside RTH, and on a
metered host there's no reason to burn a Chromium process (and RAM) overnight.
Set MARKET_HOURS_ONLY=false to run around the clock.
"""

import os
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable

OUT_DIR = os.environ.get("OPTIONSTRAT_DIR", "/data")
BUILD_EVERY_MIN = int(os.environ.get("BUILD_EVERY_MIN", "15"))
MARKET_HOURS_ONLY = os.environ.get("MARKET_HOURS_ONLY", "true").lower() not in ("0", "false", "no")
PUSH_URL = os.environ.get("FLOW_PUSH_URL")


def log(msg):
    print(f"[scraper-service {datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


# ---- market hours (ET, no external tz dependency) --------------------------
def _et_now():
    """US Eastern without pytz: EDT (UTC-4) Mar–Nov, EST (UTC-5) otherwise.
    Approximate at the DST boundaries, which is fine for a scrape window."""
    utc = datetime.now(timezone.utc)
    edt = 3 <= utc.month <= 11
    return utc + timedelta(hours=-4 if edt else -5)


def market_open():
    if not MARKET_HOURS_ONLY:
        return True
    t = _et_now()
    if t.weekday() >= 5:                      # Sat/Sun
        return False
    mins = t.hour * 60 + t.minute
    # Start a few minutes early so the 09:30 bar is captured from the open.
    return 9 * 60 + 25 <= mins <= 16 * 60 + 5


# ---- child process management ----------------------------------------------
def start_scraper():
    env = {**os.environ, "OPTIONSTRAT_DIR": OUT_DIR}
    env.setdefault("SCRAPER_HEADLESS", "true")
    env.setdefault("OPTIONSTRAT_PROFILE_DIR", str(Path(OUT_DIR) / "optionstrat_profile"))
    log("starting strata_flow.py")
    return subprocess.Popen([PY, str(HERE / "strata_flow.py")], env=env,
                            stdout=sys.stdout, stderr=sys.stderr)


def stop(proc, why=""):
    if not proc or proc.poll() is not None:
        return
    log(f"stopping scraper ({why})")
    try:
        proc.terminate()
        proc.wait(timeout=20)
    except Exception:
        try: proc.kill()
        except Exception: pass


def run_step(script, args=(), label=None):
    label = label or script
    try:
        r = subprocess.run([PY, str(HERE / script), *args],
                           capture_output=True, text=True, timeout=600,
                           env={**os.environ, "OPTIONSTRAT_DIR": OUT_DIR})
        out = (r.stdout or "").strip().splitlines()
        log(f"{label}: rc={r.returncode} {out[-1] if out else ''}")
        if r.returncode != 0 and r.stderr:
            log(f"{label} stderr: {r.stderr.strip()[:300]}")
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        log(f"{label}: TIMEOUT")
    except Exception as e:
        log(f"{label}: {e}")
    return False


def build_and_push():
    """day-CSVs -> masters -> compact cache -> deployed app."""
    Path(OUT_DIR).mkdir(parents=True, exist_ok=True)
    # The master builder resolves its files relative to CWD, so run it in OUT_DIR.
    cwd = os.getcwd()
    try:
        os.chdir(OUT_DIR)
        run_step("optionstrat_master_builder.py", label="master-builder")
    finally:
        os.chdir(cwd)
    run_step("build_flow_cache.py", (OUT_DIR,), label="build-cache")
    if PUSH_URL:
        run_step("push_flow_cache.py", (OUT_DIR,), label="push-cache")
    else:
        log("FLOW_PUSH_URL not set — cache built locally, not pushed")


def main():
    log(f"OUT_DIR={OUT_DIR} build_every={BUILD_EVERY_MIN}m "
        f"market_hours_only={MARKET_HOURS_ONLY} push={'yes' if PUSH_URL else 'no'}")
    Path(OUT_DIR).mkdir(parents=True, exist_ok=True)

    proc = None
    last_build = 0.0
    try:
        while True:
            open_now = market_open()

            # Keep the scraper alive only while it's useful.
            if open_now:
                if proc is None or proc.poll() is not None:
                    if proc is not None:
                        log(f"scraper exited rc={proc.returncode} — restarting")
                    proc = start_scraper()
            elif proc is not None and proc.poll() is None:
                stop(proc, "market closed")
                proc = None
                build_and_push()          # final build for the session
                last_build = time.time()

            # Periodic build+push while running.
            if time.time() - last_build >= BUILD_EVERY_MIN * 60:
                if open_now or last_build == 0.0:
                    build_and_push()
                last_build = time.time()

            time.sleep(30)
    except KeyboardInterrupt:
        log("interrupted")
    finally:
        stop(proc, "shutdown")


if __name__ == "__main__":
    main()
