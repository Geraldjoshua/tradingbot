// Cross-platform Python resolution.
//
// BUG THIS FIXES: every module had its own copy of
//     fs.existsSync(ROOT + "/.venv/bin/python") ? ... : "python3"
// which is the POSIX layout only. On Windows the venv interpreter lives at
// .venv\Scripts\python.exe, so the check always failed and we silently fell back
// to a bare "python3" — which on Windows usually isn't on PATH at all (it's
// "python" or the py launcher). Result: every Python-dependent feature (GEX,
// Vol Desk, market caps, flow parsing) would fail on a Windows laptop with a
// confusing "spawn failed" rather than anything actionable.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

// Ordered candidates: project venv first (so the pinned deps win), then whatever
// the platform normally calls the interpreter.
function candidates() {
  const venv = isWin
    ? [path.join(ROOT, ".venv", "Scripts", "python.exe"),
       path.join(ROOT, "venv", "Scripts", "python.exe")]
    : [path.join(ROOT, ".venv", "bin", "python"),
       path.join(ROOT, "venv", "bin", "python"),
       path.join(ROOT, ".venv", "bin", "python3")];
  const system = isWin ? ["python", "py", "python3"] : ["python3", "python"];
  return { venv, system };
}

let cached = null;

export function pythonPath() {
  if (cached) return cached;
  const { venv, system } = candidates();
  for (const p of venv) {
    if (fs.existsSync(p)) { cached = p; return cached; }
  }
  // No venv — fall back to a PATH lookup. We can't stat these, so just take the
  // platform-conventional first choice and let spawn surface any error.
  cached = system[0];
  return cached;
}

export function pythonInfo() {
  const { venv } = candidates();
  const found = venv.find((p) => fs.existsSync(p)) || null;
  return {
    platform: process.platform,
    resolved: pythonPath(),
    usingVenv: Boolean(found),
    venvPath: found,
    hint: found ? null
      : `No project venv found. Run: ${isWin
          ? "python -m venv .venv && .venv\\Scripts\\pip install -r gex\\requirements.txt"
          : "python3 -m venv .venv && .venv/bin/pip install -r gex/requirements.txt"}`,
  };
}

export const PROJECT_ROOT = ROOT;
