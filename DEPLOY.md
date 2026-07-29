# Deploying to Render

This is a **Node + Python** app with a **background loop** and **local data**, so
the clean path is one **Docker web service** (not Render's native Node runtime —
that has no easy Python venv). The included `Dockerfile` and `render.yaml` do it
for you.

## TL;DR commands
With Docker you don't set Build/Start commands in the UI — the Dockerfile is the
build, and its `CMD` is the start:

| | |
|---|---|
| Build command | *(none — the `Dockerfile` builds: `npm ci` → python venv → `npm run build`)* |
| Start command | `node server/index.js` (the Dockerfile `CMD`) |
| Health check | `/api/health` |
| Port | auto — Render sets `PORT`, the server already reads it |

## Steps
1. Push this repo to GitHub/GitLab (with `Dockerfile`, `render.yaml`, `.dockerignore`).
2. Render → **New → Blueprint** → select the repo. It reads `render.yaml`.
3. Fill the secret env vars it prompts for: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`
   (and `UW_API_KEY` only if you want Unusual Whales).
4. Create → wait for the build → open the URL. The React UI and the `/api/*`
   backend are the same origin, so no CORS/proxy config is needed in prod.

## If you'd rather NOT use the Blueprint
Create a **Web Service** manually:
- Runtime **Docker**, Dockerfile path `./Dockerfile`.
- Add a **Disk**: mount path `/app/data`, 1 GB.
- Add the env vars from `render.yaml`.
- Health check path `/api/health`.

## Running on the FREE plan (keep-alive)

`render.yaml` is set to `plan: free`. Free services *spin down* after ~15 min
with no inbound HTTP, which would freeze the auto-trader loop. Two things keep it
awake — use **both**:

1. **In-process self-ping** (`server/keepalive.js`, already wired). Every 10 min
   it hits its own `/api/health` using `RENDER_EXTERNAL_URL` (Render sets this
   automatically). This keeps it awake *while it's already running* but **cannot
   wake it from a cold sleep** — once frozen, its own timer is frozen too.
2. **External pinger** (the reliable half). Pick one:
   - **GitHub Action** — `.github/workflows/keepalive.yml` is included. Add a repo
     **variable** `HEALTHCHECK_URL = https://<your-service>.onrender.com/api/health`
     (Settings → Secrets and variables → Actions → Variables). It curls every 5 min.
   - or **cron-job.org** / **UptimeRobot** (free) pointed at the same URL.

Render's free idle window is **15 min**. With an external ping every 5 min (and
the self-ping every 10), the idle timer never fires, so the service stays warm
24/7 with comfortable margin for GitHub cron lag.

> Free-plan reality check: Render gives ~750 free instance-hours/month — enough
> for one always-on service (~744h in a 31-day month), so a single keep-warm app
> fits. Free instances can still be recycled occasionally by the platform; see #2
> below for how the loop recovers.

**1b. Make the loop restart itself after any recycle.** Because free instances
can restart (and free has no disk — see next), commit `automation.enabled: true`
in `server/autotrader.config.json` before deploying. On every boot the server
calls `autotrader.boot()`, which auto-starts the loop when that flag is true — so
a restart brings the loop back on its own instead of waiting for you to press
Start.

**2. Free has NO persistent disk — `data/` is ephemeral.** Open positions, the
action log, snapshots, and any UI toggle changes reset on every restart/redeploy.
Mitigations: it's paper (your real open contracts still live in Alpaca and are
re-read on each `evaluatePositions`); commit your preferred `autotrader.config.json`
defaults so they survive; and if you want durable history, upgrade to **Starter**
and re-add the `disk:` block shown in `render.yaml`.

**3. Secrets go in env vars, never in the repo.** `.env` is git-ignored and
docker-ignored. Set keys in the Render dashboard (`sync: false` above).

**4. OptionStrat data doesn't exist on Render by itself.** The flow conviction
reads `flow_master.xlsx` etc., which your **Playwright scraper** (`strata_flow.py`)
produces. That scraper is a browser automation job — it does **not** belong in
this web service. Options:
   - Run the scraper + master builder **locally**, then upload the `flow_*.xlsx`
     files into the disk folder `OPTIONSTRAT_DIR` (`/app/data/optionstrat`) via a
     one-off `render ssh` / shell, **or**
   - Run it as a **separate** Render Cron Job / Background Worker built from
     Playwright's own image (`mcr.microsoft.com/playwright`), writing to the same
     disk.
   Until masters exist, flow degrades gracefully: it falls back to today's flow
   day-CSV, and if there's none it returns "no data" (neutral) rather than erroring.
   You can also just toggle flow off, or flip Unusual Whales on instead.

**5. Yahoo (yfinance) can rate-limit datacenter IPs.** The GEX / Vol Desk scans
pull free Yahoo chains; from a cloud IP these are flakier than from home. Alpaca
and OptionStrat are usually fine.

**6. Config toggles reset on redeploy.** `server/autotrader.config.json` lives in
the image, so UI toggle changes are lost on the next deploy (the `data/` disk is
unaffected). Either commit your preferred defaults into that file before
deploying, or re-set them in the Auto-trader tab after a deploy.

**7. Timezone is handled in code.** The market-hours check uses
`America/New_York` explicitly, so it's correct regardless of the server's TZ.

## Local Docker sanity check (optional)
```bash
docker build -t trading-lab .
docker run -p 3001:3001 --env-file .env trading-lab
# open http://localhost:3001
```
