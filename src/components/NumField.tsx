import { useEffect, useRef, useState } from "react";
import type { InputHTMLAttributes } from "react";

// A number input that does not fight you while you type.
//
// THE BUG THIS REPLACES
// Every numeric setting in the Auto-trader tab was a controlled input wired
// straight to the server:
//
//   value={cfg.setup?.maxExtensionPct ?? 3}
//   onChange={(e) => patch({ setup: { maxExtensionPct: +e.target.value } })}
//
// and `patch()` POSTs, awaits, then calls refresh() which re-reads the config and
// calls setCfg. So EVERY KEYSTROKE did a network round trip and then overwrote
// the field with whatever came back. Typing "10" sent 1, then the reply for 1
// landed on top of the 0 you had just typed.
//
// Worse: clearing the field to retype gives `+"" === 0`, which wrote 0 — and for
// the extension filter 0 also means "disabled", and the input had
// `disabled={value <= 0}`. So clearing the box to type a new number locked the
// box. That is the glitch.
//
// The fix is the pattern the watchlist field already used ("Never clobber what
// you're in the middle of typing") applied to numbers:
//   * keep a local string draft while focused
//   * refuse to let an incoming refresh overwrite the draft mid-edit
//   * commit on blur or Enter, never per keystroke
//   * treat empty / NaN as "no change", never as 0
//
// `onCommit` takes the same shape as the old `onChange` so existing handler
// bodies work unchanged.
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number | string | undefined | null;
  onCommit: (e: { target: { value: string } }) => void;
};

export default function NumField({ value, onCommit, ...rest }: Props) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const focused = useRef(false);

  // Accept upstream changes ONLY when the user isn't editing.
  useEffect(() => {
    if (!focused.current) setDraft(String(value ?? ""));
  }, [value]);

  function commit() {
    const raw = draft.trim();
    if (raw === "" || raw === "-" || raw === ".") {   // mid-edit, not a value
      setDraft(String(value ?? ""));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setDraft(String(value ?? ""));
      return;
    }
    if (n === Number(value)) return;                   // no-op, don't POST
    onCommit({ target: { value: String(n) } });
  }

  return (
    <input
      {...rest}
      type="number"
      value={draft}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === "Escape") { setDraft(String(value ?? "")); focused.current = false; (e.target as HTMLInputElement).blur(); }
      }}
      title={(rest.title as string) || "Enter or click away to apply"}
    />
  );
}
