"""
Push flow_cache.json to the deployed trading app.

Render attaches a disk to exactly ONE service, so a scraper running as a separate
worker can't hand files to the web service through the filesystem. Instead we
POST the distilled cache to /api/flow-cache and the app writes it locally.

Bonus: this means the scraper can live anywhere — a Render worker, a VPS, or a
spare machine — and the deployed bot stays fed with no manual copying.

    export FLOW_PUSH_URL=https://your-app.onrender.com
    export FLOW_PUSH_TOKEN=some-long-random-secret     # must match the server's
    python flow/push_flow_cache.py [dir]

Exit codes: 0 pushed, 1 nothing to push / failed (safe to run on a schedule).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

CACHE_NAME = "flow_cache.json"


def push(directory=".", url=None, token=None, timeout=60):
    url = url or os.environ.get("FLOW_PUSH_URL")
    token = token or os.environ.get("FLOW_PUSH_TOKEN")
    if not url or not token:
        print("FLOW_PUSH_URL and FLOW_PUSH_TOKEN must be set", file=sys.stderr)
        return False

    path = Path(directory) / CACHE_NAME
    if not path.exists():
        print(f"no {path} — run flow/build_flow_cache.py first", file=sys.stderr)
        return False

    body = path.read_bytes()
    endpoint = url.rstrip("/") + "/api/flow-cache"
    req = urllib.request.Request(
        endpoint, data=body, method="POST",
        headers={"Content-Type": "application/json", "x-flow-token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read().decode() or "{}")
        print(f"pushed {len(body)/1024:.1f} KB -> {endpoint}  ({resp.get('tickers')} tickers)")
        return True
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:200]
        print(f"push failed: HTTP {e.code} {detail}", file=sys.stderr)
    except Exception as e:
        print(f"push failed: {e}", file=sys.stderr)
    return False


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPTIONSTRAT_DIR", ".")
    sys.exit(0 if push(d) else 1)
