#!/usr/bin/env node
// One-time environment setup:  npm run setup
//
// Creates the Python venv, installs the Python deps, and installs Playwright's
// Chromium (needed by the OptionStrat scraper). Cross-platform, because the venv
// layout differs: .venv/bin on macOS+Linux, .venv\Scripts on Windows.
//
// Safe to re-run — every step is idempotent.

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const VENV = path.join(ROOT, ".venv");
const venvPy = isWin ? path.join(VENV, "Scripts", "python.exe") : path.join(VENV, "bin", "python");

function run(cmd, args, opts = {}) {
  process.stdout.write(`\n$ ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: false, ...opts });
  return r.status === 0;
}

function firstWorking(cands) {
  for (const c of cands) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore", shell: false });
    if (r.status === 0) return c;
  }
  return null;
}

console.log("=== Trading bot setup ===");
console.log(`platform: ${process.platform}`);

// 1. Find a system Python to build the venv with.
const sysPy = firstWorking(isWin ? ["python", "py", "python3"] : ["python3", "python"]);
if (!sysPy) {
  console.error("\n✗ No Python found on PATH. Install Python 3.10+ and re-run `npm run setup`.");
  console.error(isWin ? "  https://www.python.org/downloads/windows/ (tick 'Add python.exe to PATH')"
                      : "  brew install python  (macOS)  |  apt install python3-venv  (Debian/Ubuntu)");
  process.exit(1);
}
console.log(`system python: ${sysPy}`);

// 2. Create the venv if missing.
if (fs.existsSync(venvPy)) {
  console.log(`venv already present: ${venvPy}`);
} else {
  if (!run(sysPy, ["-m", "venv", ".venv"])) {
    console.error("\n✗ Could not create the venv.");
    console.error(isWin ? "" : "  On Debian/Ubuntu you may need: sudo apt install python3-venv");
    process.exit(1);
  }
}

// 3. Python deps (yfinance for GEX/market caps, openpyxl for the workbooks,
//    playwright for the scraper).
run(venvPy, ["-m", "pip", "install", "--upgrade", "pip", "--quiet"]);
if (!run(venvPy, ["-m", "pip", "install", "-r", path.join("gex", "requirements.txt")])) {
  console.error("\n✗ pip install failed for gex/requirements.txt");
  process.exit(1);
}
if (!run(venvPy, ["-m", "pip", "install", "playwright"])) {
  console.error("\n✗ pip install playwright failed");
  process.exit(1);
}

// 4. Chromium for Playwright. This is a ~150MB download, once.
console.log("\nInstalling Chromium for the scraper (one-time, ~150MB)…");
if (!run(venvPy, ["-m", "playwright", "install", "chromium"])) {
  console.warn("\n! Chromium install failed. Everything except the OptionStrat scraper will still work.");
  console.warn("  Retry later with:  " + (isWin ? ".venv\\Scripts\\python -m playwright install chromium"
                                                : ".venv/bin/python -m playwright install chromium"));
}

// 5. .env reminder — the app cannot trade without Alpaca paper keys.
const envPath = path.join(ROOT, ".env");
if (!fs.existsSync(envPath)) {
  try {
    fs.copyFileSync(path.join(ROOT, ".env.example"), envPath);
    console.log("\ncreated .env from .env.example");
  } catch {}
  console.log("→ Edit .env and add your Alpaca PAPER keys (ALPACA_API_KEY / ALPACA_SECRET_KEY).");
} else {
  const txt = fs.readFileSync(envPath, "utf8");
  const missing = ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"]
    .filter((k) => !new RegExp(`^${k}=.+`, "m").test(txt));
  if (missing.length) console.log(`\n→ .env still needs: ${missing.join(", ")}`);
  else console.log("\n.env looks populated ✓");
}

console.log(`
=== Setup complete ===

  npm start        build the UI and run everything (server + scraper + trader)
                   then open http://localhost:3001

  npm run start:fast        same, skipping the UI rebuild
  npm run start:noscraper   local, but don't launch the scraper
`);
