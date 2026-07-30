// Wake lock — stop the laptop sleeping while the trader is running.
//
// THE HONEST FRAMING: software inside a sleeping machine cannot wake itself. Once
// the OS suspends, our timers are frozen — a stop-loss will not fire. So the fix
// is PREVENTION, not recovery: hold an OS-level "keep awake" assertion for as long
// as the process lives, and release it on exit.
//
// Each platform exposes this differently, and we use the built-in mechanism rather
// than a native npm module (no compilation, nothing to break on upgrade):
//
//   macOS    `caffeinate -s`         — assertion held while the child lives
//   Windows  PowerShell + SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)
//   Linux    `systemd-inhibit --what=sleep:idle`
//
// Scope note: we deliberately request SYSTEM sleep prevention, not DISPLAY. The
// screen can still turn off — we only care that the CPU keeps running.
//
// What this does NOT cover: closing a laptop lid usually suspends regardless
// (macOS clamshell, Windows lid action). If you need lid-closed operation you must
// change that OS setting yourself — see LOCAL.md. And if the machine sleeps anyway,
// positions sit unmanaged until it wakes; that is the real cost of self-hosting.

import { spawn } from "child_process";

let child = null;
let mode = null;
let lastError = null;

const WIN_PS = `
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$k = Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
[void]$k::SetThreadExecutionState([uint32]"0x80000001")
Write-Output "wakelock-held"
# Hold the assertion for as long as this process lives.
while ($true) { Start-Sleep -Seconds 60 }
`.trim();

export function acquire() {
  if (process.env.WAKELOCK === "off") { mode = "disabled"; return status(); }
  if (child) return status();

  try {
    if (process.platform === "darwin") {
      // -s: prevent system sleep. Display may still sleep, which is fine.
      child = spawn("caffeinate", ["-s"], { stdio: "ignore" });
      mode = "caffeinate";
    } else if (process.platform === "win32") {
      child = spawn("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_PS],
        { stdio: "ignore", windowsHide: true });
      mode = "SetThreadExecutionState";
    } else {
      child = spawn("systemd-inhibit",
        ["--what=sleep:idle", "--who=trading-bot", "--why=auto-trader running",
         "sleep", "infinity"], { stdio: "ignore" });
      mode = "systemd-inhibit";
    }

    child.on("error", (e) => {
      lastError = e.message; child = null;
      console.log(`[wakelock] unavailable (${mode}): ${e.message} — the machine may sleep; see LOCAL.md`);
      mode = "unavailable";
    });
    child.on("exit", (code) => {
      // Only surprising if we didn't ask for it.
      if (child) { lastError = `helper exited (${code})`; child = null; }
    });
    if (child.unref) child.unref();
    console.log(`[wakelock] holding — system sleep prevented via ${mode} (display may still sleep)`);
  } catch (e) {
    lastError = String(e.message || e);
    mode = "unavailable";
    console.log(`[wakelock] could not acquire: ${lastError}`);
  }
  return status();
}

export function release() {
  if (child) {
    try { child.kill(); } catch {}
    child = null;
    console.log("[wakelock] released");
  }
}

export function status() {
  return {
    held: Boolean(child),
    mode,
    platform: process.platform,
    lastError,
    note: child
      ? "System sleep is blocked while this process runs. Closing the lid may still suspend — see LOCAL.md."
      : mode === "disabled"
        ? "Disabled via WAKELOCK=off — the machine can sleep and the trader will pause."
        : "No wake lock held; the machine may sleep and stop managing positions.",
  };
}
